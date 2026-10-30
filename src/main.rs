// No console window behind the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod align;
mod aligner;
mod fonts;
mod pipeline;
mod projects;
mod speech;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};

use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::path::BaseDirectory;
use tauri::window::Color;
use tauri::{DragDropEvent, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use fonts::Fonts;
use pipeline::{Engine, ExportSettings, Format, Grade, Job, Mode, Quality, Settings, Status, tool};
use projects::Projects;
use speech::SpeechModel;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "m2ts", "wmv"];

struct Media {
    path: PathBuf,
}

struct JobRecord {
    status: Arc<Mutex<Status>>,
    cancel: Arc<AtomicBool>,
    output: PathBuf,
}

#[derive(Clone)]
struct App {
    engine: Arc<Engine>,
    fonts: Arc<Fonts>,
    speech: Arc<SpeechModel>,
    projects: Arc<Projects>,
    /// User preferences (last export folder and settings), stored as the page sends them.
    prefs_path: PathBuf,
    /// Imported colour LUTs (.cube), named by a hash of their contents.
    luts: PathBuf,
    media: Arc<Mutex<HashMap<u64, Arc<Media>>>>,
    jobs: Arc<Mutex<HashMap<u64, JobRecord>>>,
    queue: mpsc::Sender<Job>,
    work: PathBuf,
    next_id: Arc<AtomicU64>,
    /// Native dialogs are parented to the window so they open in front of it.
    window: Arc<OnceLock<WebviewWindow>>,
    /// The API is on localhost, where any program or web page can reach it. Every request
    /// must carry this per-launch secret, which only Halo's own window knows.
    token: Arc<String>,
}

impl App {
    fn media(&self, id: u64) -> Result<Arc<Media>, ApiError> {
        self.media.lock().unwrap().get(&id).cloned().ok_or((StatusCode::NOT_FOUND, "that video isn't open".into()))
    }
}

type ApiError = (StatusCode, String);

fn bad_request(e: impl std::fmt::Display) -> ApiError {
    (StatusCode::BAD_REQUEST, e.to_string())
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

/// Effect settings as sent by the page, for both previews and exports.
#[derive(Deserialize)]
struct EffectParams {
    mode: String,
    blur: Option<f32>,
    color: Option<String>,
}

impl EffectParams {
    fn settings(&self) -> Result<Settings, ApiError> {
        let mode = Mode::parse(&self.mode).ok_or_else(|| bad_request("mode must be none, blur, remove or color"))?;
        let blur = self.blur.unwrap_or(20.0);
        if !blur.is_finite() {
            return Err(bad_request("blur must be a number"));
        }
        let color = match &self.color {
            Some(c) => parse_hex(c).ok_or_else(|| bad_request("color must look like #00b140"))?,
            None => [0, 177, 64],
        };
        Ok(Settings { mode, blur: blur.clamp(2.0, 80.0), color })
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Ok(dir) = app.path().resource_dir() {
                pipeline::use_tools_from(dir);
            }
            let model =app.path().resolve("models/rvm_mobilenetv3_fp32.onnx", BaseDirectory::Resource)?;
            let engine = match Engine::new(&model) {
                Ok(engine) => Arc::new(engine),
                Err(e) => {
                    rfd::MessageDialog::new()
                        .set_level(rfd::MessageLevel::Error)
                        .set_title("Halo")
                        .set_description(format!("Halo couldn't start.\n\n{e:#}"))
                        .show();
                    std::process::exit(1);
                }
            };
            let web = app.path().resolve("web", BaseDirectory::Resource)?;
            let data = app.path().app_data_dir()?;
            let work = work_dir();
            // Caption burn-in reads fonts from next to the subtitle files.
            std::fs::create_dir_all(work.join("fonts"))?;
            for font in std::fs::read_dir(web.join("fonts"))? {
                let font = font?.path();
                if font.extension().is_some_and(|e| e == "ttf") {
                    std::fs::copy(&font, work.join("fonts").join(font.file_name().unwrap()))?;
                }
            }

            let (queue, jobs) = mpsc::channel();
            std::thread::spawn({
                let engine = engine.clone();
                move || engine.run_worker(jobs)
            });
            let fonts = Arc::new(Fonts::new(web.join("fonts")));
            // Build the font list in the background so it's ready when the inspector asks.
            std::thread::spawn({
                let fonts = fonts.clone();
                move || { fonts.list(); }
            });
            let state = App {
                engine,
                fonts,
                speech: Arc::new(SpeechModel::new(data.join("models"))),
                projects: Arc::new(Projects::new(data.join("projects"))),
                prefs_path: data.join("prefs.json"),
                luts: data.join("luts"),
                media: Default::default(),
                jobs: Default::default(),
                queue,
                work,
                next_id: Default::default(),
                window: Default::default(),
                token: Arc::new(uuid::Uuid::new_v4().simple().to_string()),
            };
            let addr = tauri::async_runtime::block_on(serve(state.clone(), web))?;

            let url = format!("http://{addr}/?token={}", state.token);
            // Only visible when Halo is started from a terminal; handy for debugging the UI in a browser.
            println!("ui: {url}");
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Halo")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                .background_color(Color(14, 15, 17, 255))
                .build()?;
            // Tauri handles file drops, which (unlike the page) knows the dropped file's path.
            window.on_window_event({
                let window = window.clone();
                move |event| {
                    let WindowEvent::DragDrop(drop) = event else { return };
                    let js = match drop {
                        DragDropEvent::Enter { .. } => "window.halo?.dragging(true)".to_string(),
                        DragDropEvent::Leave => "window.halo?.dragging(false)".to_string(),
                        DragDropEvent::Drop { paths, .. } => match paths.first() {
                            Some(path) => format!("window.halo?.openPath({})", json!(path.to_string_lossy())),
                            None => return,
                        },
                        _ => return,
                    };
                    let _ = window.eval(js);
                }
            });
            let _ = state.window.set(window);
            // Only installed (release) copies check for updates. A `cargo run` build carries the
            // placeholder version, so it would otherwise offer to "update" to a release on GitHub.
            #[cfg(not(debug_assertions))]
            tauri::async_runtime::spawn(check_for_update(app.handle().clone()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Halo")
        .run(|_, event| {
            if let RunEvent::Exit = event {
                let _ = std::fs::remove_dir_all(work_dir());
            }
        });
}

/// Looks for a newer Halo on GitHub Releases and, if the user agrees, installs it and restarts.
/// Being offline or there being no release yet is silent: updating never gets in the way.
#[cfg(not(debug_assertions))]
async fn check_for_update(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    let Ok(updater) = app.updater() else { return };
    let Ok(Some(update)) = updater.check().await else { return };
    let window = app.get_webview_window("main");
    let dialog = || {
        let d = rfd::AsyncMessageDialog::new().set_title("Halo");
        match &window {
            Some(w) => d.set_parent(w),
            None => d,
        }
    };
    let notes = update.body.as_deref().map(|b| format!("\n\n{}", b.trim())).unwrap_or_default();
    let answer = dialog()
        .set_description(format!(
            "Halo {} is available (you have {}).{notes}\n\nInstall it now? Halo will close and reopen. \
             Your projects are saved; an export in progress would be stopped.",
            update.version, update.current_version
        ))
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        .await;
    if answer != rfd::MessageDialogResult::Yes {
        return;
    }
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => app.restart(),
        Err(e) => {
            dialog()
                .set_level(rfd::MessageLevel::Error)
                .set_description(format!("The update couldn't be installed.\n\n{e}"))
                .show()
                .await;
        }
    }
}

/// Scratch files (caption files for exports) only live as long as this app instance.
fn work_dir() -> PathBuf {
    std::env::temp_dir().join("halo").join(std::process::id().to_string())
}

/// Starts the UI and API server on a free local port and returns its address.
async fn serve(app: App, web: PathBuf) -> anyhow::Result<std::net::SocketAddr> {
    let api = Router::new()
        .route("/media", post(open_media))
        .route("/media/{id}/file", get(media_file))
        .route("/media/{id}/preview", get(preview))
        .route("/media/{id}/transcribe", post(transcribe))
        .route("/media/{id}/waveform", get(waveform))
        .route("/media/{id}/thumbnails", get(thumbnails))
        .route("/dialog/open", post(dialog_open))
        .route("/dialog/save", post(dialog_save))
        .route("/projects", get(list_projects))
        .route("/projects/{id}", get(get_project).put(save_project).delete(delete_project))
        .route("/prefs", get(get_prefs).put(save_prefs))
        .route("/luts", post(import_lut))
        .route("/luts/{id}", get(lut_file))
        .route("/files/text", post(save_text))
        .route("/reveal", post(reveal_path))
        .route("/fonts", get(list_fonts))
        .route("/fonts/{id}/file", get(font_file))
        .route("/speech", get(speech_status))
        .route("/speech/download", post(speech_download))
        .route("/jobs", post(create_job))
        .route("/jobs/{id}", get(job_status))
        .route("/jobs/{id}/cancel", post(cancel_job))
        .route("/jobs/{id}/reveal", post(reveal_job))
        .route("/jobs/{id}/open", post(open_job))
        .route_layer(middleware::from_fn_with_state(app.clone(), require_token));
    let router = Router::new()
        .nest("/api", api)
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(app)
        .fallback_service(ServeDir::new(web));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tauri::async_runtime::spawn(async move { axum::serve(listener, router).await });
    Ok(addr)
}

async fn require_token(State(app): State<App>, request: Request, next: Next) -> Response {
    let header_token = request.headers().get("x-halo-token").and_then(|v| v.to_str().ok());
    // <video src> can't send headers, so media URLs carry the token in the query instead.
    let query_token = request
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|pair| pair.strip_prefix("token=")));
    if header_token.or(query_token) == Some(app.token.as_str()) {
        next.run(request).await
    } else {
        (StatusCode::FORBIDDEN, "missing or wrong token").into_response()
    }
}

#[derive(Deserialize)]
struct OpenMediaParams {
    path: String,
}

/// Registers a video file for this session and returns its details and project id.
async fn open_media(State(app): State<App>, Json(params): Json<OpenMediaParams>) -> Result<Json<Value>, ApiError> {
    let path = PathBuf::from(&params.path);
    let is_video = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIDEO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    if !is_video {
        return Err(bad_request("Halo opens video files (MP4, MOV, MKV, WebM, AVI)."));
    }
    let probe_path = path.clone();
    let info = tokio::task::spawn_blocking(move || pipeline::probe_summary(&probe_path))
        .await
        .map_err(internal)?
        .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, format!("{e:#}")))?;
    let id = app.next_id.fetch_add(1, Ordering::Relaxed);
    app.media.lock().unwrap().insert(id, Arc::new(Media { path: path.clone() }));
    Ok(Json(json!({
        "id": id,
        "path": path.to_string_lossy(),
        "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        "project_id": Projects::id_for(&path),
        "width": info.width,
        "height": info.height,
        "duration": info.duration,
        "fps": info.fps,
    })))
}

async fn media_file(State(app): State<App>, Path(id): Path<u64>, request: Request) -> Result<Response, ApiError> {
    let media = app.media(id)?;
    // ServeFile handles range requests, so the player can seek without loading the whole file.
    Ok(ServeFile::new(&media.path).oneshot(request).await.map_err(internal)?.into_response())
}

// Not `#[serde(flatten)]` like `JobParams`: flattening breaks number parsing in query strings.
#[derive(Deserialize)]
struct PreviewParams {
    t: f64,
    mode: String,
    blur: Option<f32>,
    color: Option<String>,
}

async fn preview(State(app): State<App>, Path(id): Path<u64>, Query(params): Query<PreviewParams>) -> Result<Response, ApiError> {
    let media = app.media(id)?;
    let settings = EffectParams { mode: params.mode, blur: params.blur, color: params.color }.settings()?;
    let at = if params.t.is_finite() { params.t.max(0.0) } else { 0.0 };
    let preview = tokio::task::spawn_blocking(move || app.engine.preview(&media.path, at, settings))
        .await
        .map_err(internal)?
        .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, format!("{e:#}")))?;
    Ok(([(header::CONTENT_TYPE, preview.content_type), (header::CACHE_CONTROL, "no-store")], preview.image).into_response())
}

async fn waveform(State(app): State<App>, Path(id): Path<u64>) -> Result<Json<Value>, ApiError> {
    let media = app.media(id)?;
    let peaks = tokio::task::spawn_blocking(move || pipeline::waveform(&media.path))
        .await
        .map_err(internal)?
        .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, format!("{e:#}")))?;
    Ok(Json(json!({ "rate": pipeline::WAVEFORM_RATE, "peaks": peaks })))
}

#[derive(Deserialize)]
struct ThumbnailParams {
    count: usize,
    height: usize,
}

/// A JPEG grid of evenly spaced frames; its layout is described in response headers.
async fn thumbnails(State(app): State<App>, Path(id): Path<u64>, Query(params): Query<ThumbnailParams>) -> Result<Response, ApiError> {
    let media = app.media(id)?;
    let thumbs = tokio::task::spawn_blocking(move || pipeline::thumbnails(&media.path, params.count, params.height))
        .await
        .map_err(internal)?
        .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, format!("{e:#}")))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg".to_string()),
            (header::HeaderName::from_static("x-thumb-columns"), thumbs.columns.to_string()),
            (header::HeaderName::from_static("x-thumb-width"), thumbs.thumb_width.to_string()),
        ],
        thumbs.jpeg,
    )
        .into_response())
}

#[derive(Deserialize)]
struct TranscribeParams {
    language: Option<String>,
}

async fn transcribe(
    State(app): State<App>,
    Path(id): Path<u64>,
    Json(params): Json<TranscribeParams>,
) -> Result<Json<Vec<speech::Word>>, ApiError> {
    let media = app.media(id)?;
    let language = params.language.unwrap_or_else(|| "auto".into());
    let words = tokio::task::spawn_blocking(move || app.speech.transcribe(&media.path, &language))
        .await
        .map_err(internal)?
        .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, format!("{e:#}")))?;
    Ok(Json(words))
}

/// Shows the native "open video" dialog.
async fn dialog_open(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    let path = tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("Open a video").add_filter("Videos", VIDEO_EXTENSIONS);
        if let Some(window) = app.window.get() {
            dialog = dialog.set_parent(window);
        }
        dialog.pick_file()
    })
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "path": path.map(|p| p.to_string_lossy().into_owned()) })))
}

#[derive(Deserialize)]
struct SaveDialogParams {
    file_name: String,
    extension: String,
    directory: Option<String>,
}

/// Shows the native "save as" dialog for an export.
async fn dialog_save(State(app): State<App>, Json(params): Json<SaveDialogParams>) -> Result<Json<Value>, ApiError> {
    let ext = params.extension.clone();
    let path = tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new()
            .set_title("Export video")
            .set_file_name(&params.file_name)
            .add_filter(ext.to_uppercase(), &[ext.as_str()]);
        if let Some(dir) = params.directory.filter(|d| std::path::Path::new(d).is_dir()) {
            dialog = dialog.set_directory(dir);
        }
        if let Some(window) = app.window.get() {
            dialog = dialog.set_parent(window);
        }
        dialog.save_file()
    })
    .await
    .map_err(internal)?;
    // The dialog lets people type a name without the extension; make sure it's there.
    let path = path.map(|p| if p.extension().is_some_and(|e| e.eq_ignore_ascii_case(&params.extension)) {
        p
    } else {
        let mut name = p.file_name().unwrap_or_default().to_os_string();
        name.push(format!(".{}", params.extension));
        p.with_file_name(name)
    });
    Ok(Json(json!({ "path": path.map(|p| p.to_string_lossy().into_owned()) })))
}

async fn list_projects(State(app): State<App>) -> Json<Value> {
    let projects = app.projects.clone();
    let list = tokio::task::spawn_blocking(move || projects.recent()).await.unwrap_or_default();
    Json(json!(list))
}

async fn get_project(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    match app.projects.get(&id).map_err(bad_request)? {
        Some(project) => Ok(Json(project)),
        None => Err((StatusCode::NOT_FOUND, "no saved project".into())),
    }
}

async fn save_project(State(app): State<App>, Path(id): Path<String>, Json(project): Json<Value>) -> Result<StatusCode, ApiError> {
    app.projects.save(&id, &project).map_err(bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_project(State(app): State<App>, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    app.projects.delete(&id).map_err(bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_fonts(State(app): State<App>) -> Json<Value> {
    let fonts = app.fonts.clone();
    let list = tokio::task::spawn_blocking(move || fonts.list().to_vec()).await.unwrap_or_default();
    Json(json!(list))
}

async fn font_file(State(app): State<App>, Path(id): Path<usize>, request: Request) -> Result<Response, ApiError> {
    let path = app.fonts.get(id).map(|f| f.path.clone()).ok_or((StatusCode::NOT_FOUND, "no such font".into()))?;
    Ok(ServeFile::new(path).oneshot(request).await.map_err(internal)?.into_response())
}

async fn get_prefs(State(app): State<App>) -> Json<Value> {
    let prefs = std::fs::read(&app.prefs_path).ok().and_then(|b| serde_json::from_slice(&b).ok());
    Json(prefs.unwrap_or_else(|| json!({})))
}

async fn save_prefs(State(app): State<App>, Json(prefs): Json<Value>) -> Result<StatusCode, ApiError> {
    if let Some(dir) = app.prefs_path.parent() {
        std::fs::create_dir_all(dir).map_err(internal)?;
    }
    std::fs::write(&app.prefs_path, serde_json::to_vec(&prefs).map_err(internal)?).map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn speech_status(State(app): State<App>) -> Json<speech::ModelStatus> {
    Json(app.speech.status())
}

async fn speech_download(State(app): State<App>) -> Json<speech::ModelStatus> {
    app.speech.start_download();
    Json(app.speech.status())
}

#[derive(Deserialize)]
struct JobParams {
    media: u64,
    #[serde(flatten)]
    effect: EffectParams,
    /// ASS subtitles to burn in, generated by the page.
    captions: Option<String>,
    /// For inverted captions, the letters as ASS: they show the video with its brightness flipped.
    caption_mask: Option<String>,
    /// SRT captions to save next to the video.
    srt: Option<String>,
    /// Colour grades, baked by the page into one LUT per graded stretch of the video.
    #[serde(default)]
    grades: Vec<GradeParams>,
    /// Export only the captions, over transparency.
    #[serde(default)]
    captions_only: bool,
    /// Font families the captions use, so installed (non-bundled) ones can be handed to ffmpeg.
    #[serde(default)]
    fonts: Vec<String>,
    output: String,
    /// The user agreed to replace an existing file at `output`.
    #[serde(default)]
    overwrite: bool,
    format: String,
    quality: String,
    max_side: Option<usize>,
}

#[derive(Deserialize)]
struct GradeParams {
    /// The grade as a 3D LUT in .cube format.
    cube: String,
    start: f64,
    end: f64,
}

async fn create_job(State(app): State<App>, Json(params): Json<JobParams>) -> Result<Json<Value>, ApiError> {
    let media = app.media(params.media)?;
    let settings = params.effect.settings()?;
    let format = Format::parse(&params.format).ok_or_else(|| bad_request("unknown format"))?;
    let quality = Quality::parse(&params.quality).ok_or_else(|| bad_request("unknown quality"))?;
    if (settings.mode == Mode::Remove || params.captions_only) && !format.supports_alpha() {
        return Err(bad_request("Transparent backgrounds need ProRes or WebM."));
    }
    let output = PathBuf::from(&params.output);
    if !output.is_absolute() || !output.parent().is_some_and(|d| d.is_dir()) {
        return Err(bad_request("Choose where to save the video."));
    }
    if output.exists() && !params.overwrite {
        return Err((StatusCode::CONFLICT, "A file with that name already exists.".into()));
    }
    if output == media.path {
        return Err(bad_request("Choose a different file name; this would overwrite the original video."));
    }
    let id = app.next_id.fetch_add(1, Ordering::Relaxed);
    for family in &params.fonts {
        if let Some(font) = app.fonts.by_family(family).filter(|f| !f.bundled) {
            let dest = app.work.join("fonts").join(font.path.file_name().unwrap_or_default());
            if !dest.exists() {
                tokio::fs::copy(&font.path, &dest).await.map_err(internal)?;
            }
        }
    }
    let captions = match params.captions {
        Some(ass) => {
            let path = app.work.join(format!("{id}-captions.ass"));
            tokio::fs::write(&path, ass).await.map_err(internal)?;
            Some(path)
        }
        None => None,
    };
    let caption_mask = match params.caption_mask {
        Some(ass) => {
            let path = app.work.join(format!("{id}-mask.ass"));
            tokio::fs::write(&path, ass).await.map_err(internal)?;
            Some(path)
        }
        None => None,
    };
    let mut grades = Vec::new();
    for (k, g) in params.grades.iter().enumerate() {
        if !(g.start.is_finite() && g.end.is_finite() && g.end > g.start) {
            return Err(bad_request("a graded section has no length"));
        }
        let lut = app.work.join(format!("{id}-grade{k}.cube"));
        tokio::fs::write(&lut, &g.cube).await.map_err(internal)?;
        grades.push(Grade { lut, start: g.start.max(0.0), end: g.end });
    }
    let status = Arc::new(Mutex::new(Status { state: "queued", ..Default::default() }));
    let cancel = Arc::new(AtomicBool::new(false));
    app.jobs
        .lock()
        .unwrap()
        .insert(id, JobRecord { status: status.clone(), cancel: cancel.clone(), output: output.clone() });
    let export = ExportSettings { format, quality, max_side: params.max_side.filter(|&s| s >= 240) };
    app.queue
        .send(Job {
            input: media.path.clone(),
            output,
            captions,
            caption_mask,
            srt: params.srt,
            grades,
            captions_only: params.captions_only,
            settings,
            export,
            status,
            cancel,
        })
        .map_err(|_| internal("the export worker has stopped; restart Halo"))?;
    Ok(Json(json!({ "id": id })))
}

/// Keeps an imported LUT in Halo's library and returns its id. The page has already checked it
/// parses; this only stores it.
async fn import_lut(State(app): State<App>, body: String) -> Result<Json<Value>, ApiError> {
    use std::hash::{Hash, Hasher};
    if !body.lines().any(|l| l.trim_start().starts_with("LUT_3D_SIZE")) {
        return Err(bad_request("That isn't a 3D .cube LUT."));
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    body.hash(&mut hasher);
    let id = format!("{:016x}", hasher.finish());
    tokio::fs::create_dir_all(&app.luts).await.map_err(internal)?;
    tokio::fs::write(app.luts.join(format!("{id}.cube")), body).await.map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

async fn lut_file(State(app): State<App>, Path(id): Path<String>) -> Result<Response, ApiError> {
    if id.len() != 16 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(bad_request("bad LUT id"));
    }
    let text = tokio::fs::read_to_string(app.luts.join(format!("{id}.cube")))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "That LUT is no longer in Halo's library.".to_string()))?;
    Ok(([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response())
}

#[derive(Deserialize)]
struct SaveTextParams {
    path: String,
    text: String,
    #[serde(default)]
    overwrite: bool,
}

/// Saves caption text files (SRT, WebVTT) where the user chose in the Save As dialog.
async fn save_text(Json(params): Json<SaveTextParams>) -> Result<StatusCode, ApiError> {
    let path = PathBuf::from(&params.path);
    let allowed = path.extension().and_then(|e| e.to_str()).is_some_and(|e| ["srt", "vtt"].contains(&e.to_ascii_lowercase().as_str()));
    if !allowed || !path.is_absolute() || !path.parent().is_some_and(|d| d.is_dir()) {
        return Err(bad_request("Choose where to save the captions."));
    }
    if path.exists() && !params.overwrite {
        return Err((StatusCode::CONFLICT, "A file with that name already exists.".into()));
    }
    tokio::fs::write(&path, params.text).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RevealParams {
    path: String,
}

/// Opens Explorer with a file selected.
async fn reveal_path(Json(params): Json<RevealParams>) -> Result<StatusCode, ApiError> {
    let path = PathBuf::from(&params.path);
    if !path.is_file() {
        return Err((StatusCode::NOT_FOUND, "That file isn't there any more.".into()));
    }
    let mut select = std::ffi::OsString::from("/select,");
    select.push(&path);
    tool("explorer").arg(select).spawn().map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

fn job<T>(app: &App, id: u64, f: impl FnOnce(&JobRecord) -> T) -> Result<T, ApiError> {
    let jobs = app.jobs.lock().unwrap();
    jobs.get(&id).map(f).ok_or((StatusCode::NOT_FOUND, "no such export".into()))
}

async fn job_status(State(app): State<App>, Path(id): Path<u64>) -> Result<Json<Value>, ApiError> {
    job(&app, id, |job| {
        let mut body = serde_json::to_value(&*job.status.lock().unwrap()).unwrap_or_default();
        body["output"] = job.output.to_string_lossy().into_owned().into();
        Json(body)
    })
}

async fn cancel_job(State(app): State<App>, Path(id): Path<u64>) -> Result<StatusCode, ApiError> {
    job(&app, id, |job| job.cancel.store(true, Ordering::Relaxed))?;
    Ok(StatusCode::NO_CONTENT)
}

fn finished_output(app: &App, id: u64) -> Result<PathBuf, ApiError> {
    let (state, output) = job(app, id, |job| (job.status.lock().unwrap().state, job.output.clone()))?;
    if state != "done" {
        return Err((StatusCode::CONFLICT, "the export isn't finished".into()));
    }
    Ok(output)
}

/// Opens Explorer with the exported file selected.
async fn reveal_job(State(app): State<App>, Path(id): Path<u64>) -> Result<StatusCode, ApiError> {
    let output = finished_output(&app, id)?;
    let mut select = std::ffi::OsString::from("/select,");
    select.push(&output);
    tool("explorer").arg(select).spawn().map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Opens the exported file in the default video player.
async fn open_job(State(app): State<App>, Path(id): Path<u64>) -> Result<StatusCode, ApiError> {
    let output = finished_output(&app, id)?;
    tool("explorer").arg(&output).spawn().map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let s = s.strip_prefix('#')?;
    if s.len() != 6 {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(s.get(i..i + 2)?, 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}
