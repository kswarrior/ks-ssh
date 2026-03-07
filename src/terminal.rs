use actix_web::{web, HttpRequest, HttpResponse};
use actix_web_actors::ws;
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct TerminalServer {
    pub sessions: Arc<Mutex<Vec<ws::WebsocketContext<TerminalSession>>>>,
}

impl TerminalServer {
    pub fn new() -> Self {
        TerminalServer { sessions: Arc::new(Mutex::new(vec![])) }
    }
    pub fn broadcast(&self, msg: &str) {
        let sessions = self.sessions.lock().unwrap();
        for ctx in sessions.iter() { ctx.text(msg); }
    }
}

pub struct TerminalSession {
    pub server: TerminalServer,
}

impl actix::Actor for TerminalSession {
    type Context = ws::WebsocketContext<Self>;
    fn started(&mut self, ctx: &mut Self::Context) {
        self.server.sessions.lock().unwrap().push(ctx.clone());
    }
}

impl actix::StreamHandler<Result<ws::Message, ws::ProtocolError>> for TerminalSession {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        if let Ok(ws::Message::Text(command)) = msg {
            // Run the command in shell and send output
            let output = Command::new("sh")
                .arg("-c")
                .arg(command)
                .stdout(Stdio::piped())
                .output();
            if let Ok(output) = output {
                let result = String::from_utf8_lossy(&output.stdout);
                ctx.text(result);
            }
        }
    }
}

pub async fn ws_route(req: HttpRequest, stream: web::Payload, srv: web::Data<TerminalServer>) -> Result<HttpResponse, actix_web::Error> {
    ws::start(TerminalSession { server: srv.get_ref().clone() }, &req, stream)
}
