use actix::prelude::*;
use actix_web::Error;
use actix_web_actors::ws;
use std::process::{Command, Stdio, Child, ChildStdin};
use std::io::{BufRead, BufReader, Write};
use std::thread;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Clone)]
pub struct TerminalServer {
    sessions: Arc<Mutex<Vec<Addr<TerminalSession>>>>,
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct Broadcast(pub String);

#[derive(Message)]
#[rtype(result = "()")]
pub struct TerminalOutput(pub String);

pub struct TerminalSession {
    server: TerminalServer,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

impl TerminalSession {
    pub fn new(server: TerminalServer) -> Self {
        TerminalSession {
            server,
            child: None,
            stdin: None,
        }
    }
}

impl Actor for TerminalSession {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        // Spawn persistent shell process
        let mut child = Command::new("/bin/sh")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("Failed to spawn shell");

        // Take stdout for reading in thread
        let stdout = child.stdout.take().expect("Failed to take stdout");
        let addr = ctx.address();

        // Spawn thread to read shell output and forward to actor
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(output) = line {
                    let _ = addr.do_send(TerminalOutput(output + "\n"));
                }
            }
        });

        // Store child and stdin
        self.child = Some(child);
        self.stdin = Some(child.stdin.take().expect("Failed to take stdin"));

        // Register this session for broadcasts (e.g., Cloudflare URL)
        let mut sessions = self.server.sessions.lock().unwrap();
        sessions.push(ctx.address());
    }

    fn stopped(&mut self, _ctx: &mut Self::Context) {
        // Clean up shell on disconnect
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"exit\n");
            let _ = stdin.flush();
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }

        // Remove from server sessions
        let mut sessions = self.server.sessions.lock().unwrap();
        sessions.retain(|addr| !addr.same(&self.server.sessions.lock().unwrap()[0])); // Simplified removal; in production, use index or ID
    }
}

impl Handler<Broadcast> for TerminalSession {
    type Result = ();

    fn handle(&mut self, msg: Broadcast, ctx: &mut Self::Context) {
        ctx.text(msg.0);
    }
}

impl Handler<TerminalOutput> for TerminalSession {
    type Result = ();

    fn handle(&mut self, msg: TerminalOutput, ctx: &mut Self::Context) {
        ctx.text(msg.0);
    }
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for TerminalSession {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        if let Ok(ws::Message::Text(text)) = msg {
            // Translate \r to \n for shell compatibility
            if let Some(stdin) = self.stdin.as_mut() {
                let mut bytes = text.as_bytes().to_vec();
                for b in bytes.iter_mut() {
                    if *b == b'\r' {
                        *b = b'\n';
                    }
                }
                let _ = stdin.write_all(&bytes);
                let _ = stdin.flush();
            }
        }
        // Ignore other message types (e.g., Ping/Pong, Binary)
    }
}

impl TerminalServer {
    pub fn new() -> Self {
        TerminalServer {
            sessions: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn broadcast(&self, msg: &str) {
        let sessions = self.sessions.lock().unwrap();
        for addr in sessions.iter() {
            addr.do_send(Broadcast(msg.to_string()));
        }
    }
}
