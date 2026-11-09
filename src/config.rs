//! Paths, ports and addresses, read once at start-up from the environment and the optional config.json.
use serde_json::{Map, Value};
use std::env;
use std::fs;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::LazyLock;

pub const VERSION: &str = env!("MYTUBE_VERSION");
pub const MAX_JOBS: usize = 2;

pub struct Config {
    pub home: PathBuf,
    /// Things that must survive restarts (your data, archives, config, window profile). One folder for the app
    /// and for `MyTube.exe --server`, so the app and a browser tab always see the same data.
    pub data_dir: PathBuf,
    pub video_dir: PathBuf,
    pub audio_dir: PathBuf,
    pub bind: String,
    pub port: u16,
    pub invidious: String,
    /// What the *browser* uses for thumbnails/streams. Change it when hosting moves (build guide 13.4).
    pub invidious_public: String,
    /// Optional %LOCALAPPDATA%\MyTube\config.json:
    /// {"ytdlp": "C:\\path\\yt-dlp.exe", "distro": "Ubuntu-24.04", "videoDir": "D:\\Videos", "audioDir": "D:\\Music"}
    pub file: Map<String, Value>,
}

pub static CONFIG: LazyLock<Config> = LazyLock::new(|| {
    let var = |name: &str| env::var(name).ok().filter(|v| !v.is_empty());
    let home = PathBuf::from(var("USERPROFILE").or_else(|| var("HOME")).unwrap_or_else(|| ".".into()));
    let data_dir = var("MYTUBE_DATA").map(PathBuf::from).unwrap_or_else(|| {
        var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Local")).join("MyTube")
    });
    let file = fs::read_to_string(data_dir.join("config.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| if let Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default();
    let dir_setting = |key: &str, default: PathBuf| match file.get(key) {
        Some(Value::String(s)) if !s.is_empty() => PathBuf::from(s),
        _ => default,
    };
    Config {
        video_dir: dir_setting("videoDir", home.join("Videos").join("yt")),
        audio_dir: dir_setting("audioDir", home.join("Music").join("yt")),
        bind: var("YT_BIND").unwrap_or_else(|| "127.0.0.1".into()),
        port: var("YT_PORT").and_then(|p| p.parse().ok()).unwrap_or(8080),
        invidious: var("INVIDIOUS_URL").unwrap_or_else(|| "http://127.0.0.1:3000".into()).trim_end_matches('/').into(),
        invidious_public: var("INVIDIOUS_PUBLIC_URL").unwrap_or_else(|| "http://localhost:3000".into()),
        home,
        data_dir,
        file,
    }
});

impl Config {
    pub fn setting(&self, key: &str) -> Option<&str> {
        self.file.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
    }

    pub fn config_file(&self) -> PathBuf {
        self.data_dir.join("config.json")
    }

    /// host:port of the Invidious URL, for a quick "is anything listening" check.
    pub fn invidious_addr(&self) -> Option<SocketAddr> {
        let rest = self.invidious.split_once("://").map_or(self.invidious.as_str(), |(_, r)| r);
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        let with_port = if authority.rsplit_once(':').is_some_and(|(_, p)| p.parse::<u16>().is_ok()) {
            authority.to_string()
        } else {
            format!("{authority}:80")
        };
        with_port.to_socket_addrs().ok()?.next()
    }
}
