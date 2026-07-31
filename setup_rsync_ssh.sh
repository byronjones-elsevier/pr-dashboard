#!/usr/bin/env bash

echo "================================================="
echo "   Termux Rsync & Public Key SSH Auto-Setup"
echo "================================================="

# 1. Storage Access Check
if [ ! -d "$HOME/storage/shared" ]; then
    echo "[*] Requesting storage access... Please accept the popup on your screen."
    termux-setup-storage
    echo "Waiting for storage permission to apply..."
    sleep 3
else
    echo "[✓] Storage access already granted."
fi

# 2. Package Installation Checks
echo "[*] Updating package index..."
apt update -y || { echo "[-] Failed to update package index."; exit 1; }

PACKAGES=(openssh rsync termux-api)
MISSING_PKGS=()
for pkg in "${PACKAGES[@]}"; do
    if dpkg -s "$pkg" >/dev/null 2>&1; then
        echo "[✓] $pkg is already installed."
    else
        MISSING_PKGS+=("$pkg")
    fi
done

if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
    echo "[*] Installing missing packages: ${MISSING_PKGS[*]}..."
    apt install -y "${MISSING_PKGS[@]}" || { echo "[-] Package installation failed."; exit 1; }
fi

# 3. Establish SSH Directory Architecture
SSH_DIR="$HOME/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"
SSH_CONFIG="$SSH_DIR/config"

if [ ! -d "$SSH_DIR" ]; then
    echo "[*] Creating SSH directory..."
    mkdir -p "$SSH_DIR"
    chmod 700 "$SSH_DIR"
else
    echo "[✓] SSH directory exists."
fi

if [ ! -f "$AUTH_KEYS" ]; then
    touch "$AUTH_KEYS"
    chmod 600 "$AUTH_KEYS"
fi

# 4. Local Key Pair Generation (For Android-to-PC or Git usage)
ID_ED25519="$SSH_DIR/id_ed25519"
if [ ! -f "$ID_ED25519" ]; then
    echo "[*] Generating Ed25519 SSH Key Pair for Android..."
    ssh-keygen -t ed25519 -N "" -f "$ID_ED25519"
else
    echo "[✓] Android Ed25519 key pair already exists."
fi

# 5. Local SSH Client Config Creation
if [ ! -f "$SSH_CONFIG" ]; then
    echo "[*] Creating base client configuration file..."
    cat << 'EOC' > "$SSH_CONFIG"
# Termux SSH Client Configuration
Host *
    AddKeysToAgent yes
    IdentityFile ~/.ssh/id_ed25519
EOC
    chmod 600 "$SSH_CONFIG"
else
    echo "[✓] SSH client config already exists."
fi

# 6. Verify Phone Password (Required as a backup fallback)
if ! grep -q '^..' /data/data/com.termux/files/usr/etc/passwd 2>/dev/null; then
    echo "======================================"
    echo "[!] CRITICAL: Set a password for backup/initial login access."
    echo "======================================"
    passwd || { echo "[-] Failed to set password."; exit 1; }
fi

# 7. Start and Verify SSH Daemon
echo "[*] Starting SSH daemon..."
pkill sshd 2>/dev/null
sshd

if pgrep sshd >/dev/null; then
    echo "[✓] SSH server running on port 8022."
else
    echo "[-] Error: SSH server failed to start."; exit 1;
fi

# 8. Networking and Variable Generation
IP_ADDR=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7}')
[ -z "$IP_ADDR" ] && IP_ADDR=$(ifconfig 2>/dev/null | grep -v '127.0.0.1' | awk '/inet / {print $2}' | cut -d: -f2 | head -n1)

if [ -z "$IP_ADDR" ]; then
    echo "[-] Error: No Wi-Fi IP address found. Connect to Wi-Fi and re-run."
    exit 1
fi

USER_NAME=$(whoami)
DEST_PATH="$HOME/storage/shared/Download"

echo ""
echo "=========================================================================="
echo "                         SUCCESS! SETUP COMPLETE                  "
echo "=========================================================================="
echo " Android IP Address:  $IP_ADDR"
echo " Termux Username:     $USER_NAME"
echo "=========================================================================="
echo ""
echo "👉 STEP 1: RUN THIS LINE ON YOUR PC TO IMPORT YOUR PC'S PUBLIC KEY TO PHONE:"
echo "   ssh-copy-id -p 8022 $USER_NAME@$IP_ADDR"
echo "   (Type the Termux password you just created when prompted)"
echo ""
echo "👉 STEP 2: FOR CONVENIENCE, ADD THIS TO YOUR PC'S SSH CONFIG (~/.ssh/config):"
echo "Host android"
echo "    HostName $IP_ADDR"
echo "    Port 8022"
echo "    User $USER_NAME"
echo ""
echo "👉 STEP 3: EXAMPLES USING KEY PAIR AUTHENTICATION (AFTER STEPS 1 & 2):"
echo "   • SSH Into Phone:   ssh android"
echo "   • Push Folders:     rsync -avzP --omit-dir-times --no-perms --inplace /path/to/pc/folder/ android:$DEST_PATH/"
echo "   • Pull Folders:     rsync -avzP --omit-dir-times --no-perms --inplace android:$DEST_PATH/ /path/to/pc/dest/"
echo "=========================================================================="

