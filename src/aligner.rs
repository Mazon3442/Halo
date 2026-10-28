//! Exact word timings by forced alignment: wav2vec2 hears which letter is spoken in every 20 ms
//! of audio, and the transcript's letters are lined up against that, in order, at the most
//! likely positions (CTC Viterbi alignment, as WhisperX does). English only, like the model.

use std::path::Path;

use anyhow::{Result, bail};
use ort::{session::Session, value::TensorRef};

use crate::align::SAMPLE_RATE;
use crate::pipeline::ort_env;
use crate::speech::Word;

pub const MODEL_FILE: &str = "wav2vec2-base-960h-int8.onnx";
pub const MODEL_URL: &str = "https://huggingface.co/onnx-community/wav2vec2-base-960h-ONNX/resolve/main/onnx/model_int8.onnx";

/// The model's classes: 0 is CTC's "nothing new" blank, 4 the gap between words, and the
/// letters (plus apostrophe) follow in this order from 5.
const CLASSES: usize = 32;
const BLANK: usize = 0;
const SPACE: usize = 4;
const LETTERS: &str = "ETAONIHSRDLUMWCFGYPBVK'XJQZ";
/// Stands for a word with nothing the model can spell, like "250": it matches any sound.
const ANY: usize = usize::MAX;

/// Samples per output frame, and audio fed to the model at a time to bound its memory.
const STRIDE: usize = 320;
const CHUNK: usize = SAMPLE_RATE * 20;
/// How far past Whisper's times a word may be found: its starts run early, its ends are close.
const LEAD: f64 = 1.5;
const TRAIL: f64 = 1.0;
const LOOKAHEAD: usize = 4;

/// Aligns the words to the audio in place. Fails if the model can't be loaded or run, so the
/// caller can fall back to a rougher method; stretches that can't be aligned keep their times.
pub fn align(model: &Path, words: &mut [Word], samples: &[i16]) -> Result<()> {
    if words.is_empty() {
        return Ok(());
    }
    let mut session = Session::builder(&ort_env()?)?.commit_from_file(model)?;
    let (logp, times) = emissions(&mut session, samples)?;

    let mut from = 0;
    let mut floor = 0.0;
    while from < words.len() {
        let to = block_end(words, from);
        // A few words past the block are aligned with it so they hold on to their own sounds;
        // they're placed for real with the next block.
        let ahead = (to + LOOKAHEAD).min(words.len());
        let (t0, t1) = ((words[from].start - LEAD).max(floor), words[ahead - 1].end + TRAIL);
        let f0 = times.partition_point(|&t| t < t0);
        let f1 = times.partition_point(|&t| t < t1);
        if let Some(spans) = viterbi(&words[from..ahead], &logp, f0, f1) {
            for (word, (a, b)) in words[from..to].iter_mut().zip(spans) {
                word.start = times[a];
                word.end = times[b.min(times.len() - 1)];
            }
            floor = words[to - 1].end;
        }
        from = to;
    }
    settle(words);
    Ok(())
}

/// Log-probabilities of each class for every frame, and each frame's time in seconds.
fn emissions(session: &mut Session, samples: &[i16]) -> Result<(Vec<f32>, Vec<f64>)> {
    let (mut logp, mut times) = (Vec::new(), Vec::new());
    for (c, chunk) in samples.chunks(CHUNK).enumerate() {
        if chunk.len() < STRIDE * 2 {
            break;
        }
        // The model expects each input normalised to zero mean and unit variance.
        let x: Vec<f32> = chunk.iter().map(|&s| s as f32 / 32768.0).collect();
        let mean = x.iter().sum::<f32>() / x.len() as f32;
        let std = (x.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / x.len() as f32).sqrt().max(1e-5);
        let x: Vec<f32> = x.iter().map(|v| (v - mean) / std).collect();
        let outputs = session.run(ort::inputs! { "input_values" => TensorRef::from_array_view(([1usize, x.len()], &x[..]))? })?;
        let (shape, values) = outputs["logits"].try_extract_tensor::<f32>()?;
        if shape.len() != 3 || shape[2] as usize != CLASSES {
            bail!("unexpected alignment model output {shape:?}");
        }
        for (i, frame) in values.chunks_exact(CLASSES).enumerate() {
            let max = frame.iter().cloned().fold(f32::MIN, f32::max);
            let sum = frame.iter().map(|v| (v - max).exp()).sum::<f32>().ln() + max;
            logp.extend(frame.iter().map(|v| v - sum));
            times.push(((c * CHUNK + i * STRIDE) as f64) / SAMPLE_RATE as f64);
        }
    }
    Ok((logp, times))
}

/// Words are aligned a sentence or so at a time, each within the stretch of audio where Whisper
/// heard it, which keeps the search small and an error in one stretch out of the next.
fn block_end(words: &[Word], from: usize) -> usize {
    let mut to = from + 1;
    while to < words.len() {
        let span = words[to - 1].end - words[from].start;
        let gap = words[to].start - words[to - 1].end;
        let sentence = words[to - 1].text.ends_with(['.', '?', '!', ',']);
        if gap > 1.0 || (span > 8.0 && sentence) || span > 25.0 {
            break;
        }
        to += 1;
    }
    to
}

/// The model's classes for spelling a word, or ANY when it has nothing the model can spell.
fn spell(text: &str) -> Vec<usize> {
    let classes: Vec<usize> = text
        .chars()
        .filter_map(|c| LETTERS.find(c.to_ascii_uppercase()).map(|i| i + 5))
        .collect();
    if classes.is_empty() || text.chars().any(|c| c.is_ascii_digit()) { vec![ANY] } else { classes }
}

/// Finds the most likely frames for each word's letters within frames f0..f1 and returns each
/// word's first and last frame, or None if the letters can't fit.
fn viterbi(words: &[Word], logp: &[f32], f0: usize, f1: usize) -> Option<Vec<(usize, usize)>> {
    // The letters to find, a space between words, and which word each one belongs to.
    // The stretch of audio may catch the end of the sentence before and the start of the one
    // after; an optional "anything" at each end soaks those up instead of the words.
    let mut tokens = vec![ANY];
    let mut owner = vec![usize::MAX];
    for (w, word) in words.iter().enumerate() {
        if w > 0 {
            tokens.push(SPACE);
            owner.push(usize::MAX);
        }
        for class in spell(&word.text) {
            tokens.push(class);
            owner.push(w);
        }
    }
    tokens.push(ANY);
    owner.push(usize::MAX);
    // CTC states: a blank before, between and after every token.
    let states = tokens.len() * 2 + 1;
    let frames = f1.saturating_sub(f0);
    if frames < tokens.len() {
        return None;
    }
    let class_of = |s: usize| if s % 2 == 0 { BLANK } else { tokens[s / 2] };
    let emit = |t: usize, s: usize| {
        let row = &logp[(f0 + t) * CLASSES..(f0 + t + 1) * CLASSES];
        match class_of(s) {
            // A little less likely than a real letter, so the words claim the sounds that fit them.
            ANY => row[1..].iter().cloned().fold(f32::MIN, f32::max) - 1.0,
            c => row[c],
        }
    };

    let mut score = vec![f32::NEG_INFINITY; states];
    let mut next = vec![f32::NEG_INFINITY; states];
    // How far back each state stepped at each frame: 0, 1 or 2 states.
    let mut back = vec![0u8; frames * states];
    // Starting past the leading "anything" (state 3 is the first letter) is allowed too.
    for s in 0..4 {
        score[s] = emit(0, s);
    }
    for t in 1..frames {
        for s in 0..states {
            let mut best = (score[s], 0u8);
            if s >= 1 && score[s - 1] > best.0 {
                best = (score[s - 1], 1);
            }
            // A token may follow the previous token directly, skipping the blank between them,
            // unless they're the same letter twice ("ll" needs a blank to be heard as two).
            if s >= 2 && s % 2 == 1 && class_of(s) != class_of(s - 2) && score[s - 2] > best.0 {
                best = (score[s - 2], 2);
            }
            next[s] = best.0 + emit(t, s);
            back[t * states + s] = best.1;
        }
        std::mem::swap(&mut score, &mut next);
    }

    // Likewise ending before the trailing "anything": on the last letter or the blank after it.
    let mut s = (states - 4..states).max_by(|&a, &b| score[a].total_cmp(&score[b])).unwrap();
    if !score[s].is_finite() {
        return None;
    }
    let mut spans = vec![(usize::MAX, 0); words.len()];
    for t in (0..frames).rev() {
        if s % 2 == 1 && owner[s / 2] != usize::MAX {
            let span = &mut spans[owner[s / 2]];
            span.0 = span.0.min(f0 + t);
            span.1 = span.1.max(f0 + t + 1);
        }
        s -= back[t * states + s] as usize;
    }
    spans.iter().all(|&(a, _)| a != usize::MAX).then_some(spans)
}

/// The model marks each letter at a single instant, so a word's last letter ends early. Words
/// run on to the next one across short gaps, and otherwise hold a moment after they're said.
fn settle(words: &mut [Word]) {
    for i in 0..words.len() {
        let next = words.get(i + 1).map(|w| w.start);
        let w = &mut words[i];
        w.end = match next {
            Some(n) if n - w.end < 0.25 => n,
            Some(n) => (w.end + 0.15).min(n),
            None => w.end + 0.15,
        }
        .max(w.start + 0.02);
    }
}

