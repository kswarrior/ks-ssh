use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct TerminalServer(Arc<broadcast::Sender<String>>);

impl TerminalServer {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(100);
        Self(Arc::new(tx))
    }

    pub fn broadcast(&self, msg: &str) {
        let _ = self.0.send(msg.to_string());
    }
}
