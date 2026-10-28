//! Moves Whisper's word times onto the speech that's actually audible.
//!
//! whisper.cpp's word timestamps come from its token timings, which run early and stretch
//! across pauses: a caption can show up a second before anyone talks. The audio's loudness
//! tells us where speech really is, so words are dealt out to those stretches of speech in
//! order, guided by how long each word should take to say and roughly where Whisper put it.

use crate::speech::Word;

/// The audio's sample rate, and 10 ms of it: the step of the loudness envelope.
pub const SAMPLE_RATE: usize = 16_000;
const HOP: usize = SAMPLE_RATE / 100;
const FRAME: f64 = 0.01;

/// Pauses shorter than this stay inside one phrase; blips shorter than the other are noise.
const MIN_GAP: usize = 20;
const MIN_PHRASE: usize = 6;
/// Most words a phrase may hold, and how far from Whisper's time a word may move, in seconds.
const MAX_BLOCK: usize = 40;
const MAX_SHIFT: f64 = 5.0;

/// Refines word times in place from 16 kHz mono samples. Leaves them alone when the audio
/// has no clear silences to go by, such as speech over music.
pub fn refine(words: &mut [Word], samples: &[i16]) {
    let db = envelope(samples);
    let Some(phrases) = phrases(&db) else { return };
    if words.is_empty() || phrases.is_empty() {
        return;
    }

    // Expected speaking time of each word, scaled so they add up to the time spent talking.
    let mut need: Vec<f64> = words.iter().map(|w| weight(&w.text)).collect();
    let spoken: f64 = phrases.iter().map(|&(a, b)| (b - a) as f64 * FRAME).sum();
    let rate = spoken / need.iter().sum::<f64>();
    need.iter_mut().for_each(|n| *n *= rate);

    let Some(blocks) = assign(words, &need, &phrases) else { return };
    for (&(a, b), (from, to)) in phrases.iter().zip(blocks) {
        place(&mut words[from..to], &need[from..to], a, b, &db);
    }
}

/// Loudness in dB per 10 ms, measured over 20 ms windows.
fn envelope(samples: &[i16]) -> Vec<f64> {
    (0..samples.len().div_ceil(HOP))
        .map(|i| {
            let window = &samples[i * HOP..(i * HOP + 2 * HOP).min(samples.len())];
            let power = window.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum::<f64>() / window.len() as f64;
            10.0 * (power + 1e-18).log10()
        })
        .collect()
}

/// Stretches of speech as frame ranges, or None if speech and silence can't be told apart.
fn phrases(db: &[f64]) -> Option<Vec<(usize, usize)>> {
    let mut sorted = db.to_vec();
    sorted.sort_by(f64::total_cmp);
    let floor = *sorted.get(sorted.len() / 10)?;
    let loud = sorted[sorted.len() * 9 / 10];
    if loud - floor < 12.0 {
        return None;
    }
    let threshold = floor + 7.0;

    let mut merged: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < db.len() {
        if db[i] <= threshold {
            i += 1;
            continue;
        }
        let start = i;
        while i < db.len() && db[i] > threshold {
            i += 1;
        }
        match merged.last_mut() {
            Some(last) if start - last.1 < MIN_GAP => last.1 = i,
            _ => merged.push((start, i)),
        }
    }
    merged.retain(|&(a, b)| b - a >= MIN_PHRASE);
    let voiced: usize = merged.iter().map(|&(a, b)| b - a).sum();
    // Nearly wall-to-wall sound means the silences are masked; Whisper's times are the better guess.
    (voiced * 10 < db.len() * 9).then_some(merged)
}

/// Rough time a word takes to say, before scaling to the speaker's pace.
fn weight(text: &str) -> f64 {
    // A digit is a whole word out loud: "250" is "two hundred fifty".
    let letters: usize = text.chars().map(|c| if c.is_ascii_digit() { 4 } else { c.is_alphanumeric() as usize }).sum();
    0.1 + 0.06 * letters as f64
}

/// Splits the words into one run per phrase, in order, at the lowest total cost. Returns the
/// word range of each phrase, or None if no split keeps every word near Whisper's time for it.
fn assign(words: &[Word], need: &[f64], phrases: &[(usize, usize)]) -> Option<Vec<(usize, usize)>> {
    let (n, p) = (words.len(), phrases.len());
    let mut cost = vec![f64::INFINITY; (p + 1) * (n + 1)];
    let mut back = vec![0usize; (p + 1) * (n + 1)];
    let at = |j: usize, i: usize| j * (n + 1) + i;
    cost[at(0, 0)] = 0.0;

    for j in 1..=p {
        let (a, b) = (phrases[j - 1].0 as f64 * FRAME, phrases[j - 1].1 as f64 * FRAME);
        let len = b - a;
        for i in 0..=n {
            // Leaving a phrase empty is allowed (a cough, a laugh) but costs, so speech gets words.
            let mut best = cost[at(j - 1, i)] + len * 3.0;
            let mut from = i;
            let (mut want, mut drift) = (0.0, 0.0);
            for k in (i.saturating_sub(MAX_BLOCK)..i).rev() {
                let w = &words[k];
                if (a - w.end).max(w.start - b) > MAX_SHIFT {
                    break;
                }
                // Whisper's word ends are close to right; its starts stretch back into pauses.
                // An end may run a little past the phrase as the word trails off.
                want += need[k];
                drift += (a - w.end).max(w.end - (b + 0.3)).max(0.0) * 2.0;
                if cost[at(j - 1, k)].is_finite() {
                    let count = (i - k) as f64;
                    let mut c = cost[at(j - 1, k)] + 4.0 * (len / want).ln().powi(2) * count.sqrt() + drift;
                    // People pause at punctuation, so phrases like to end on it.
                    if words[i - 1].text.ends_with([',', '.', '?', '!']) {
                        c -= 1.5;
                    }
                    if c < best {
                        best = c;
                        from = k;
                    }
                }
            }
            cost[at(j, i)] = best;
            back[at(j, i)] = from;
        }
    }

    if !cost[at(p, n)].is_finite() {
        return None;
    }
    let mut blocks = vec![(0, 0); p];
    let mut i = n;
    for j in (1..=p).rev() {
        let from = back[at(j, i)];
        blocks[j - 1] = (from, i);
        i = from;
    }
    Some(blocks)
}

/// Spreads a phrase's words across it by expected length, moving each boundary between two
/// words to the quietest moment nearby, but never by more than half of either word.
fn place(words: &mut [Word], need: &[f64], a: usize, b: usize, db: &[f64]) {
    let total: f64 = need.iter().sum();
    let share = |k: usize| (b - a) as f64 * need[k] / total;
    let mut start = a;
    let mut elapsed = 0.0;
    for (k, word) in words.iter_mut().enumerate() {
        elapsed += need[k];
        let end = if k + 1 == need.len() {
            b
        } else {
            let guess = a + ((b - a) as f64 * elapsed / total).round() as usize;
            let lo = guess.saturating_sub(((share(k) / 2.0) as usize).min(8)).max(start + 1);
            let hi = (guess + ((share(k + 1) / 2.0) as usize).min(8)).min(b - 1);
            (lo..=hi).min_by(|&x, &y| db[x].total_cmp(&db[y])).unwrap_or(guess.max(start + 1).min(b))
        };
        word.start = start as f64 * FRAME;
        word.end = end as f64 * FRAME;
        start = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Speech from 1 to 2 s and 3 to 4 s with Whisper's times drifted early into the silence.
    #[test]
    fn moves_words_out_of_silence() {
        let mut samples = vec![0i16; SAMPLE_RATE * 5];
        for (i, s) in samples.iter_mut().enumerate() {
            let t = i as f64 / SAMPLE_RATE as f64;
            if (1.0..2.0).contains(&t) || (3.0..4.0).contains(&t) {
                *s = ((t * 900.0).sin() * 8000.0) as i16;
            } else {
                *s = ((i * 7919 % 13) as i16) - 6;
            }
        }
        let word = |text: &str, start: f64, end: f64| Word { text: text.into(), start, end };
        let mut words = vec![
            word("hello", 0.0, 0.6),
            word("there,", 0.6, 1.5),
            word("general", 1.5, 2.4),
            word("kenobi.", 2.4, 3.6),
        ];
        refine(&mut words, &samples);
        assert!((words[0].start - 1.0).abs() < 0.05, "{}", words[0].start);
        assert!((words[1].end - 2.0).abs() < 0.05, "{}", words[1].end);
        assert!((words[2].start - 3.0).abs() < 0.05, "{}", words[2].start);
        assert!((words[3].end - 4.0).abs() < 0.05, "{}", words[3].end);
    }
}

