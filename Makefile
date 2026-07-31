.DEFAULT_GOAL := help

.PHONY: help install setup dev build \
        build-macos-arm build-macos-x64 \
        build-windows-x64 build-windows-arm \
        build-linux-x64 clean

# ── Help ───────────────────────────────────────────────────────────────────────
help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
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
	  aarch64-pc-windows-msvc \
	  x86_64-unknown-linux-gnu

# ── Development ────────────────────────────────────────────────────────────────
dev: ## Launch the app in development mode
	npm run dev

# ── Native build ───────────────────────────────────────────────────────────────
build: ## Build for the current host platform (output: src-tauri/target/release/bundle/)
	npm run build

# ── Cross-platform builds ──────────────────────────────────────────────────────
build-macos-arm: ## macOS Apple Silicon — .dmg + .app
	npm run build -- --target aarch64-apple-darwin

build-macos-x64: ## macOS Intel — .dmg + .app
	npm run build -- --target x86_64-apple-darwin

build-windows-x64: ## Windows x64 — .msi + .exe (NSIS); must run on Windows
	npm run build -- --target x86_64-pc-windows-msvc

build-windows-arm: ## Windows ARM64 — .msi + .exe (NSIS); cross-compile from x64 Windows
	npm run build -- --target aarch64-pc-windows-msvc

build-linux-x64: ## Linux x64 — .deb + .AppImage; must run on Linux
	npm run build -- --target x86_64-unknown-linux-gnu

# ── Maintenance ────────────────────────────────────────────────────────────────
clean: ## Remove Rust build artifacts
	cd src-tauri && cargo clean
