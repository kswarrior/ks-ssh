use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use serde_json;
use crate::terminal::TerminalServer;

pub fn run(server: TerminalServer) {
    let file_path = "cloudflared";

    // Download cloudflared silently if missing (assumes Linux AMD64; extend for other platforms if needed)
    if !std::path::Path::new(file_path).exists() {
        let _ = Command::new("wget")
            .args([
                "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
                "-O",
                file_path,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        let _ = Command::new("chmod")
            .args(["+x", file_path])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    // Start the tunnel
    let mut child = Command::new("./cloudflared")
        .args(["tunnel", "--url", "http://localhost:3000"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("Failed to start cloudflared tunnel");

    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);

    for line in reader.lines() {
        if let Ok(l) = line {
            if l.starts_with("https://") && l.contains(".trycloudflare.com") {
                // Broadcast the link to all connected clients as JSON
                let json_msg = serde_json::json!({"type": "url", "url": l}).to_string();
                server.broadcast(&json_msg);

                // Print friendly message
                let enjoy_msg = "\n\nEnjoy KS SSH!\n".to_string();
                server.broadcast(&enjoy_msg);
            }
        }
    }

    let _ = child.wait();
}
