use crate::error::AppError;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use std::fs;
use std::path::Path;

const MAX_EDGE: u32 = 1600;

pub fn write_cover_jpeg(dest: &Path, bytes: &[u8]) -> Result<u64, AppError> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    match image::load_from_memory(bytes) {
        Ok(img) => {
            let img = if img.width().max(img.height()) > MAX_EDGE {
                img.resize(MAX_EDGE, MAX_EDGE, FilterType::Lanczos3)
            } else {
                img
            };
            let rgb = img.to_rgb8();
            let file = fs::File::create(dest)?;
            let mut encoder = JpegEncoder::new_with_quality(file, 90);
            encoder.encode_image(&rgb)?;
        }
        Err(_) if bytes.starts_with(&[0xFF, 0xD8]) => {
            fs::write(dest, bytes)?;
        }
        Err(err) => return Err(err.into()),
    }
    Ok(fs::metadata(dest)?.len())
}

pub fn cover_len(path: Option<&str>) -> u64 {
    path.and_then(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0)
}

pub fn should_replace_cover(current_source: Option<&str>, current_len: u64, incoming_len: usize) -> bool {
    match current_source {
        None | Some("pdf_page") => incoming_len > 0,
        _ => incoming_len as u64 > current_len,
    }
}
