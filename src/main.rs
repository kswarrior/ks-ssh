mod html;
mod terminal;
mod cloudflare;

use actix_web::{App, HttpServer, web, HttpResponse, Error, HttpRequest};
use std::thread;
use terminal::TerminalServer;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    println!("KS SSH running on http://127.0.0.1:3000");

    let terminal_server = TerminalServer::new();
    let srv_data = web::Data::new(terminal_server.clone());

    // Run Cloudflare tunnel in background
    let srv_clone = terminal_server.clone();
    thread::spawn(move || {
        cloudflare::run(srv_clone);
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

fn ws_route(
    req: HttpRequest,
    stream: web::Payload,
    srv: web::Data<TerminalServer>,
) -> Result<HttpResponse, Error> {
    use actix_web_actors::ws;
    ws::start(
        terminal::TerminalSession::new(srv.into_inner().clone()),
        &req,
        stream,
    )
}
