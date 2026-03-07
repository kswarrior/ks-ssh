use actix::prelude::*;
use actix_web_actors::ws;
use std::process::{Command, Stdio, Child, ChildStdin};
use std::io::{BufRead, BufReader, Write};
use std::thread;
use std::sync::Arc;
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Clone)]
pub struct TerminalServer {
    sessions: Arc<Mutex<Vec<(Uuid, Addr<TerminalSession>)>>>,
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
    id: Uuid,
}

impl TerminalSession {
    pub fn new(server: TerminalServer) -> Self {
        TerminalSession {
            server,
            child: None,
            stdin: None,
            id: Uuid::new_v4(),
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
            .stderr(Stdio::piped())
            .spawn()
            .expect("Failed to spawn shell");

        let id = self.id;
        let addr = ctx.address();

        // Take stdout and stderr for reading in threads
        let stdout = child.stdout.take().expect("Failed to take stdout");
        let stderr = child.stderr.take().expect("Failed to take stderr");

        // Spawn thread to read shell stdout and forward to actor
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(output) = line {
                    let _ = addr.do_send(TerminalOutput(output + "\n"));
                }
            }
        });

        // Spawn thread to read shell stderr and forward colored to actor
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(err) = line {
                    let colored = format!("\x1b[31m{}\x1b[0m\n", err);
                    let _ = addr.do_send(TerminalOutput(colored));
                }
            }
        });

        // Store child and stdin
        self.child = Some(child);
        self.stdin = child.stdin.take().map(|s| s);

        // Register this session for broadcasts
        let mut sessions = self.server.sessions.lock().unwrap();
        sessions.push((id, ctx.address()));
    }

    fn stopped(&mut self, _ctx: &mut Self::Context) {
        // Send exit and cleanup shell on disconnect
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"exit\n");
            let _ = stdin.flush();
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }

        // Remove from server sessions
        let id = self.id;
        let mut sessions = self.server.sessions.lock().unwrap();
        sessions.retain(|(sid, _)| *sid != id);
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
        for (_, addr) in sessions.iter() {
            addr.do_send(Broadcast(msg.to_string()));
        }
    }
}
