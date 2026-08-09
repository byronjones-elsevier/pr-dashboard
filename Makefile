.DEFAULT_GOAL := help

.PHONY: help install setup dev build \
        build-macos-arm build-macos-x64 \
        build-windows-x64 build-linux-x64 \
        build-all stage clean

# ── Help ───────────────────────────────────────────────────────────────────────
help: ## Show available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sort \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

# ── Setup ──────────────────────────────────────────────────────────────────────
install: ## Install Node and Rust dependencies
	npm install

setup: install ## Add all cross-compilation Rust targets
	rustup target add \
	  aarch64-apple-darwin \
	  x86_64-apple-darwin \
	  x86_64-pc-windows-msvc \
	  x86_64-unknown-linux-gnu

# ── Development ────────────────────────────────────────────────────────────────
dev: ## Launch the app in development mode
	npm run dev

# ── Native build ───────────────────────────────────────────────────────────────
build: ## Build for the current host platform (output: src-tauri/target/release/bundle/)
	npm run build

# ── Cross-platform builds ──────────────────────────────────────────────────────
# Each target stages its raw executable + installer(s) into dist/<name>/.
# macOS targets can cross-build both arches on any Mac; Windows/Linux installers
# must be built on that native OS (matches the GitHub Actions runner matrix).
build-macos-arm: ## macOS Apple Silicon — raw binary + .dmg installer
	npm run build -- --target aarch64-apple-darwin
	@$(MAKE) --no-print-directory stage TARGET=aarch64-apple-darwin NAME=macos-arm64 EXE=pr-dashboard

build-macos-x64: ## macOS Intel — raw binary + .dmg installer
	npm run build -- --target x86_64-apple-darwin
	@$(MAKE) --no-print-directory stage TARGET=x86_64-apple-darwin NAME=macos-x64 EXE=pr-dashboard

build-windows-x64: ## Windows x64 — raw binary + .msi/.exe installers; must run on Windows
	npm run build -- --target x86_64-pc-windows-msvc
	@$(MAKE) --no-print-directory stage TARGET=x86_64-pc-windows-msvc NAME=windows-x64 EXE=pr-dashboard.exe

build-linux-x64: ## Linux x64 — raw binary + .deb/.AppImage installers; must run on Linux
	npm run build -- --target x86_64-unknown-linux-gnu
	@$(MAKE) --no-print-directory stage TARGET=x86_64-unknown-linux-gnu NAME=linux-x64 EXE=pr-dashboard

build-all: build-macos-arm build-macos-x64 build-windows-x64 build-linux-x64 ## Build all 4 targets (Windows/Linux installers require running on that OS)

# Internal: copy the raw executable + the whole bundle/ tree into dist/$(NAME)/.
stage:
	@mkdir -p dist/$(NAME)
	@cp src-tauri/target/$(TARGET)/release/$(EXE) dist/$(NAME)/$(EXE)
	@cp -R src-tauri/target/$(TARGET)/release/bundle/. dist/$(NAME)/ 2>/dev/null || true
	@echo "→ dist/$(NAME)/"

# ── Maintenance ────────────────────────────────────────────────────────────────
clean: ## Remove Rust build artifacts and staged dist/ output
	cd src-tauri && cargo clean
	rm -rf dist
