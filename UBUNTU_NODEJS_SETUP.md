# Installing Node.js on Ubuntu VM

This guide shows you how to install Node.js on your Ubuntu VM so you can run the browser inspector and other Node.js scripts.

## Method 1: Using NodeSource Repository (Recommended)

This method installs the latest LTS version of Node.js directly from NodeSource.

### Step 1: Update your system

```bash
sudo apt update
sudo apt upgrade -y
```

### Step 2: Install required packages

```bash
sudo apt install -y curl ca-certificates gnupg
```

### Step 3: Add NodeSource repository

```bash
# For Node.js 20.x (LTS - Recommended)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

# OR for Node.js 18.x (if you prefer)
# curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
```

### Step 4: Install Node.js

```bash
sudo apt install -y nodejs
```

### Step 5: Verify installation

```bash
node --version
npm --version
```

You should see output like:

```
v20.11.0
10.2.4
```

---

## Method 2: Using NVM (Node Version Manager)

NVM allows you to install and manage multiple Node.js versions easily.

### Step 1: Install NVM

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
```

### Step 2: Reload your shell configuration

```bash
source ~/.bashrc
# OR if using zsh:
# source ~/.zshrc
```

### Step 3: Install Node.js LTS

```bash
nvm install --lts
nvm use --lts
```

### Step 4: Set default version (optional)

```bash
nvm alias default node
```

### Step 5: Verify installation

```bash
node --version
npm --version
```

### Useful NVM commands

```bash
# List installed versions
nvm list

# Install specific version
nvm install 20.11.0

# Switch to a version
nvm use 20.11.0

# Set default version
nvm alias default 20.11.0
```

---

## Method 3: Using Ubuntu Default Repository (Simplest, but older version)

This method is simplest but usually installs an older version of Node.js.

```bash
sudo apt update
sudo apt install -y nodejs npm
```

**Note:** This typically installs Node.js 12.x or 18.x, which may not be the latest. Check your project's requirements first.

---

## After Installation: Install Project Dependencies

Once Node.js is installed, navigate to your project and install dependencies:

```bash
cd /path/to/master-crawl
npm install
```

## Installing Display Dependencies (For Browser Inspector)

If you plan to use the browser inspector on your Ubuntu VM, you'll also need display dependencies:

```bash
sudo apt update
sudo apt install -y \
  libnss3 \
  libatk-bridge2.0-0 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \
  libxss1 \
  libasound2 \
  libatspi2.0-0 \
  libgtk-3-0
```

## Troubleshooting

### "Command not found: node" after installation

If `node` command is not found after installation:

1. **Check if Node.js is installed:**

   ```bash
   which node
   /usr/bin/node --version
   ```

2. **Reload your shell:**

   ```bash
   source ~/.bashrc
   # OR
   exec bash
   ```

3. **Check PATH:**

   ```bash
   echo $PATH
   ```

### Permission errors with npm

If you get permission errors when using npm globally:

1. **Fix npm permissions (recommended):**

   ```bash
   mkdir ~/.npm-global
   npm config set prefix '~/.npm-global'
   echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
   source ~/.bashrc
   ```

2. **OR use sudo (not recommended for security):**

   ```bash
   sudo npm install -g <package>
   ```

### Node.js version is too old

If you need a newer version:

1. **If using NodeSource method:** Update the repository URL to a newer version
2. **If using apt:** Use Method 1 (NodeSource) or Method 2 (NVM) instead
3. **If using NVM:** Install a newer version with `nvm install <version>`

## Recommended Setup for Your Project

Based on your project structure, I recommend:

1. **Use Method 1 (NodeSource)** for a clean, system-wide installation
2. **Install Node.js 20.x LTS** (current LTS version)
3. **Install display dependencies** if you'll use the browser inspector
4. **Install project dependencies** with `npm install`

## Quick One-Liner (NodeSource Method)

If you want to install everything quickly:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && \
sudo apt install -y nodejs

# Install display dependencies (for browser inspector)
sudo apt install -y \
  libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
  libxss1 libasound2 libatspi2.0-0 libgtk-3-0

# Verify
node --version
npm --version
```

## Next Steps

After installing Node.js:

1. **Clone/upload your project** to the VM
2. **Install dependencies:**

   ```bash
   cd master-crawl
   npm install
   ```

3. **Set up environment variables** (copy from `.env.example` if needed)
4. **Run the browser inspector:**

   ```bash
   node server/utils/browserInspector.js --job <job-id> --not-found
   ```
