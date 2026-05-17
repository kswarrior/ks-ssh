# 💠 KS-SSH: The Ultimate Browser-Based Command Center

**KS SSH** is a high-performance, all-in-one terminal manager and system administration HUD designed for the modern web. Built with Go and Node.js, it provides a seamless experience for managing your VPS or local machine through a beautiful, responsive browser interface.

---

## 🚀 Why KS-SSH is the Best Ever

Unlike traditional web-based SSH clients that require complex setups or external dependencies, KS-SSH is designed to be **self-contained, ultra-fast, and visually stunning.**

*   **Zero Installation**: Native Go implementation. No need for `npx localtunnel`, `cloudflared`, or external proxy binaries. Everything is inside the library.
*   **True Persistence**: Your terminal sessions, file explorer paths, and HUD customizations are saved across browser refreshes.
*   **Mobile-First Design**: A dedicated mobile dock, virtual keypad (CTRL, ALT, ESC, etc.), and responsive layouts make system management from your phone a breeze.
*   **Aesthetic HUD**: A "True Black" and "Electric Blue" theme with glassmorphism effects provides a professional, IDE-like feel.

---

## ✨ Future-Proof Features

### 💻 Native Terminal HUD
*   **Multiple Tabs**: Open and manage multiple terminal sessions simultaneously.
*   **Session Restoration**: Re-connect to active terminals with full output history (buffer replay) even after a refresh.
*   **Full Job Control**: Interactive shell support (`bash -i`) with proper job control (Ctrl+C, Ctrl+Z).
*   **Virtual Keypad**: Specialized mobile keys for power users on the go.

### 📁 Advanced Storage HUD
*   **Modern File Explorer**: Intuitive navigation with breadcrumbs and extension-based icons.
*   **Power Actions**: Integrated file editor with real-time syntax highlighting, recursive search, zipping, and multi-file management.
*   **Universal Upload**: Upload files directly from your computer or fetch them from a remote URL.

### 🌐 Network HUD & Port Management
*   **Service Scanner**: Instantly scan and list active local services.
*   **SSL Preview**: Preview web services over HTTP or HTTPS with a single toggle.
*   **TCP interaction**: Connect to any port for raw TCP communication via a dedicated socket interaction modal.

### 🔒 Built-in Secure Tunneling
*   **Native localtunnel**: Instantly expose your HUD to the web using our built-in tunnel client.
*   **Custom Subdomains**: Request specific URLs (e.g., `https://my-vps.loca.lt`) directly from the CLI.
*   **Secure Tokens**: Uses a unique `ks-lt-` token system for identification.

---

## 🛠️ Quick Start

### 1. Build from Source
Ensure you have Node.js (v20+) and Go installed.

```bash
# Clone the repository
git clone https://github.com/kswarrior/ks-ssh
cd ks-ssh

# Build frontend and backend
bash build.sh
```

### 2. Run the HUD
Start the server with your desired configuration:

```bash
# Standard run (Port 3000)
./ks-ssh-go

# Run with custom port and custom tunnel subdomain
./ks-ssh-go --port 8080 --url my-custom-server
```

---

## 📱 Mobile Experience
KS-SSH automatically detects mobile viewports to provide a compact, touch-friendly interface:
*   **Mobile Dock**: Quick access to Terminals, Files, and Ports at the bottom of the screen.
*   **Responsive Details**: System information (CPU/RAM/IP) wraps perfectly on narrow screens.
*   **Virtual Keyboard**: Access terminal-specific keys without needing a physical keyboard.

---

## ⚙️ Customization
The HUD Settings modal allows you to personalize your workspace:
*   Change **Theme Accent Colors**.
*   Adjust **Glass Opacity** for background panels.
*   Configure **Terminal Font Sizes** and cursor styles.
*   Modify **File & Port list** appearance.

---

## ⚖️ License
©️ **KS Warrior**. Built for power users who demand the best in system management.
