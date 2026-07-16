//! Runtime resolution and process supervision for the Grok Build engine.
//!
//! The engine is a separate binary (bundled by default). This crate does not
//! link against engine crates; it only spawns `grok agent stdio`.

mod resolve;
mod spawn;

pub use resolve::*;
pub use spawn::*;
