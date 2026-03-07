mod html;
mod terminal;
mod cloudflare;

use actix_web::{web, App, Error, HttpRequest, HttpResponse, HttpServer, rt};
use actix_ws::{AggregatedMessage, WsProtocolError};
use futures_util::StreamExt;
use std::io;
use terminal::TerminalServer;

#[actix_web::main]
async fn main() -> io::Result<()> {
    println!("KS SSH running on http://127.0.0.1:3000");

    let terminal_server = TerminalServer::new();
    let srv_data = web::Data::new(terminal_server.clone());

    // Run Cloudflare tunnel in background
    let srv_clone = terminal_server.clone();
    tokio::spawn(async move {
        cloudflare::run(srv_clone).await;
    });

    HttpServer::new(move || {
        App::new()
            .app_data(srv_data.clone())
            .route("/", web::get().to(get_index))
            .route("/ws", web::get().to(ws_route))
    })
    .bind(("127.0.0.1", 3000))?
    .run()
    .await
}

async fn get_index() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .body(html::PAGE)
}

async fn ws_route(
    req: HttpRequest,
    stream: web::Payload,
    data: web::Data<TerminalServer>,
) -> Result<HttpResponse, Error> {
    let (res, mut session, mut stream) = actix_ws::handle(&req, stream)?;

    let srv_clone = data.into_inner().clone();
    let mut rx = srv_clone.subscribe();

    // Aggregate continuations and limit size
    let mut stream = stream
        .aggregate_continuations()
        .max_continuation_size(1 << 20);

    // Spawn shell process
    let mut child = tokio::process::Command::new("/bin/sh")
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .expect("Failed to spawn shell");

    let mut stdin = child.stdin.take().expect("Failed to open stdin");
    let stdout = child.stdout.take().expect("Failed to open stdout");

    let mut buf_reader = tokio::io::BufReader::new(stdout);
    let mut line = String::new();

    rt::spawn(async move {
        loop {
            tokio::select! {
                res = buf_reader.read_line(&mut line) => {
                    match res {
                        Ok(0) => break,
                        Ok(_) => {
                            let output = format!("{}\n", line.trim_end_matches('\n'));
                            let _ = session.text(output).await;
                            line.clear();
                        }
                        Err(_) => break,
                    }
                }
                msg_res = stream.next() => {
                    let msg = match msg_res {
                        Some(Ok(msg)) => msg,
                        _ => {
                            break;
                        }
                    };
                    match msg {
                        AggregatedMessage::Text(text) => {
                            let mut bytes = text.into_bytes();
                            for b in bytes.iter_mut() {
                                if *b == b'\r' {
                                    *b = b'\n';
                                }
                            }
                            if stdin.write_all(&bytes).await.is_err() || stdin.flush().await.is_err() {
                                break;
                            }
                        }
                        AggregatedMessage::Ping(msg) => {
                            let _ = session.pong(&msg).await;
                        }
                        AggregatedMessage::Close(_) => break,
                        _ => {}
                    }
                }
                recv_res = rx.recv() => {
                    match recv_res {
                        Ok(msg) => {
                            let _ = session.text(msg).await;
                        }
                        Err(_) => {
                            // Sender closed or lagged; ignore or break
                        }
                    }
                }
            }
        }
    });

    Ok(res)
}
