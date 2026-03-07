mod html;
mod terminal;
mod cloudflare;

use actix_web::{App, HttpServer, web};
use std::thread;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    println!("KS ssh running on http://127.0.0.1:3000");

    let terminal_server = terminal::TerminalServer::new();
    let srv_data = web::Data::new(terminal_server.clone());

    // Run Cloudflare tunnel in background
    let srv_clone = terminal_server.clone();
    thread::spawn(move || { cloudflare::run(srv_clone); });

    HttpServer::new(move || {
        App::new()
            .app_data(srv_data.clone())
            .route("/", web::get().to(|| async {
                actix_web::HttpResponse::Ok()
                    .content_type("text/html; charset=utf-8")
                    .body(html::PAGE)
            }))
            .route("/ws", web::get().to(terminal::ws_route))
    })
    .bind(("127.0.0.1", 3000))?
    .run()
    .await
}
