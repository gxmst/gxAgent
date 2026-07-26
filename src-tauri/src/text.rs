//! UTF-8 helpers shared by streaming and truncation paths.

/// Return the largest prefix whose UTF-8 byte length does not exceed `max_bytes`.
pub fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }

    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

/// Return the largest suffix whose UTF-8 byte length does not exceed `max_bytes`.
pub fn utf8_suffix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }

    let mut start = value.len().saturating_sub(max_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

/// Incrementally decode arbitrary byte chunks without corrupting UTF-8 codepoints
/// that happen to be split across chunk boundaries.
#[derive(Default, Debug)]
pub struct IncrementalUtf8Decoder {
    pending: Vec<u8>,
}

impl IncrementalUtf8Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();

        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    output.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        // SAFETY: `valid_up_to` is guaranteed by Utf8Error.
                        output.push_str(unsafe {
                            std::str::from_utf8_unchecked(&self.pending[..valid_up_to])
                        });
                        self.pending.drain(..valid_up_to);
                    }

                    match error.error_len() {
                        Some(invalid_len) => {
                            output.push('\u{fffd}');
                            let drain = invalid_len.min(self.pending.len());
                            self.pending.drain(..drain);
                        }
                        None => break,
                    }
                }
            }
        }

        output
    }

    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let output = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_and_suffix_respect_multibyte_boundaries() {
        let text = "abc中文🙂xyz";
        assert_eq!(utf8_prefix(text, 5), "abc");
        assert_eq!(utf8_prefix(text, 6), "abc中");
        assert_eq!(utf8_suffix(text, 5), "xyz");
        assert_eq!(utf8_suffix(text, 7), "🙂xyz");
    }

    #[test]
    fn incremental_decoder_preserves_split_codepoints() {
        let bytes = "你好🙂world".as_bytes();
        let mut decoder = IncrementalUtf8Decoder::default();
        let mut output = String::new();
        for chunk in bytes.chunks(2) {
            output.push_str(&decoder.push(chunk));
        }
        output.push_str(&decoder.finish());
        assert_eq!(output, "你好🙂world");
    }

    #[test]
    fn incremental_decoder_replaces_invalid_bytes_once() {
        let mut decoder = IncrementalUtf8Decoder::default();
        let output = decoder.push(&[b'a', 0xff, b'b']);
        assert_eq!(output, "a\u{fffd}b");
        assert_eq!(decoder.finish(), "");
    }
}
