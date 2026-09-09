#![deny(clippy::all)]

pub mod async_entry;
pub mod entry;
mod credential_result;

#[cfg(target_os = "linux")]
mod linux_credential_builder;
