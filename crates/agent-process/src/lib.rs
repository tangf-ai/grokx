//! Runtime resolution and process supervision for the Grok Build engine.
//!
//! The engine is a separately installed binary. This crate does not
//! link against engine crates; it only spawns `grok agent stdio`.

mod resolve;
mod spawn;

pub use resolve::*;
pub use spawn::*;
