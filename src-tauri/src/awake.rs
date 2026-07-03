//! Keep-awake (PowerToys Awake style) — port of WinForge Services/AwakeService.
//!
//! `SetThreadExecutionState(ES_CONTINUOUS | …)` is per-thread and persists only
//! while that thread lives, so requests are serviced by one dedicated worker
//! thread instead of the Tauri command pool (whose threads come and go). An
//! optional timer auto-reverts to normal power behaviour.

use std::sync::mpsc::{RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

const ES_CONTINUOUS: u32 = 0x8000_0000;
const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;

#[link(name = "kernel32")]
extern "system" {
    fn SetThreadExecutionState(es_flags: u32) -> u32;
}

#[derive(Clone, Copy, PartialEq)]
enum Req {
    Off,
    On { display: bool, until: Option<Instant> },
}

#[derive(Serialize, Clone, Copy)]
pub struct AwakeStatus {
    pub active: bool,
    pub display: bool,
    /// Seconds until auto-off; null when indefinite or inactive.
    pub remaining_secs: Option<u64>,
}

static TX: OnceLock<Sender<Req>> = OnceLock::new();
static STATE: Mutex<Option<(bool, Option<Instant>)>> = Mutex::new(None);

fn worker_tx() -> &'static Sender<Req> {
    TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Req>();
        std::thread::Builder::new()
            .name("awake-worker".into())
            .spawn(move || {
                let mut current = Req::Off;
                loop {
                    // While a timed request is active, wake up in time to expire it.
                    let timeout = match current {
                        Req::On { until: Some(t), .. } => {
                            t.saturating_duration_since(Instant::now())
                        }
                        _ => Duration::from_secs(3600),
                    };
                    match rx.recv_timeout(timeout) {
                        Ok(req) => current = req,
                        Err(RecvTimeoutError::Timeout) => {
                            if let Req::On { until: Some(t), .. } = current {
                                if Instant::now() >= t {
                                    current = Req::Off;
                                }
                            }
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                    let flags = match current {
                        Req::Off => ES_CONTINUOUS,
                        Req::On { display, .. } => {
                            ES_CONTINUOUS
                                | ES_SYSTEM_REQUIRED
                                | if display { ES_DISPLAY_REQUIRED } else { 0 }
                        }
                    };
                    unsafe {
                        SetThreadExecutionState(flags);
                    }
                    let mut st = STATE.lock().unwrap();
                    *st = match current {
                        Req::Off => None,
                        Req::On { display, until } => Some((display, until)),
                    };
                }
            })
            .expect("spawn awake worker");
        tx
    })
}

fn status_now() -> AwakeStatus {
    let st = STATE.lock().unwrap();
    match *st {
        None => AwakeStatus { active: false, display: false, remaining_secs: None },
        Some((display, until)) => AwakeStatus {
            active: true,
            display,
            remaining_secs: until.map(|t| t.saturating_duration_since(Instant::now()).as_secs()),
        },
    }
}

/// Enable/disable keep-awake. `minutes = 0` (or omitted) keeps it on until
/// turned off; otherwise it auto-reverts after that many minutes.
#[tauri::command]
pub fn awake_set(active: bool, display: bool, minutes: Option<u64>) -> Result<AwakeStatus, String> {
    let req = if active {
        let until = match minutes.unwrap_or(0) {
            0 => None,
            m if m <= 24 * 60 => Some(Instant::now() + Duration::from_secs(m * 60)),
            _ => return Err("minutes out of range (max 1440)".into()),
        };
        Req::On { display, until }
    } else {
        Req::Off
    };
    worker_tx().send(req).map_err(|e| e.to_string())?;
    // The worker applies the request asynchronously; reflect the intent
    // immediately so the UI doesn't race the thread.
    let mut st = STATE.lock().unwrap();
    *st = match req {
        Req::Off => None,
        Req::On { display, until } => Some((display, until)),
    };
    drop(st);
    Ok(status_now())
}

#[tauri::command]
pub fn awake_status() -> AwakeStatus {
    status_now()
}
