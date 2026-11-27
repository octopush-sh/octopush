//! How a case-insensitive APFS volume compares file names (#1229): two
//! names are the same file when they match after Unicode canonical
//! decomposition (NFD) and full case folding. So `ſ` is `s`, the Kelvin
//! sign is `k`, `ﬂ` is `fl`, and a composed `é` is `e` followed by U+0301.
//! The Talk guard reads names through [`fold`], and the sandbox's
//! case-insensitive deny regexes take their letters from [`letter_forms`],
//! so both match a name the way the volume does.

use caseless::Caseless;
use unicode_normalization::UnicodeNormalization;

/// `name` as the volume compares it: NFD, full case folding, then NFD again
/// (folding can produce a character that decomposes). Two names are the
/// same file when their folds are equal.
pub fn fold(name: &str) -> String {
    name.chars().nfd().default_case_fold().nfd().collect()
}

/// The characters outside ASCII that fold to a single ASCII letter: the
/// Kelvin sign (to `k`) and the long s (to `s`).
/// `every_char_that_folds_to_one_ascii_letter_is_listed` checks the list.
const NON_ASCII_LETTERS: [char; 2] = ['\u{212A}', '\u{017F}'];

/// Every single character that folds to the ASCII letter `letter`: its two
/// cases, then any of [`NON_ASCII_LETTERS`] that fold to it. A character
/// that folds to more than one letter (`ﬂ`) can't stand in a character
/// class; [`fold`] matches those.
pub fn letter_forms(letter: char) -> Vec<char> {
    let target = fold(&letter.to_string());
    let mut forms = vec![letter.to_ascii_lowercase(), letter.to_ascii_uppercase()];
    forms.dedup();
    forms.extend(NON_ASCII_LETTERS.iter().copied().filter(|c| fold(&c.to_string()) == target));
    forms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_long_s_the_kelvin_sign_and_ligatures_fold_to_ascii() {
        assert_eq!(fold(".mcp.j\u{017F}on"), ".mcp.json");
        assert_eq!(fold("tas\u{212A}s.json"), "tasks.json");
        assert_eq!(fold("work\u{FB02}ows"), "workflows");
        assert_eq!(fold("CLAUDE.MD"), "claude.md");
        assert_eq!(fold("Stra\u{DF}e"), fold("STRASSE"));
    }

    #[test]
    fn a_composed_and_a_decomposed_name_fold_the_same() {
        let (nfc, nfd) = ("Caf\u{E9}.md", "Cafe\u{301}.md");
        assert_ne!(nfc, nfd);
        assert_eq!(fold(nfc), fold(nfd));
        assert_eq!(fold("\u{C5}ngstr\u{F6}m"), fold("A\u{30A}ngstro\u{308}m"));
        // A mark keeps the name apart from the bare letter.
        assert_ne!(fold(nfd), fold("cafe.md"));
    }

    #[test]
    fn letter_forms_are_both_cases_and_the_characters_that_fold_to_the_letter() {
        assert_eq!(letter_forms('a'), vec!['a', 'A']);
        assert_eq!(letter_forms('K'), vec!['k', 'K', '\u{212A}']);
        assert_eq!(letter_forms('s'), vec!['s', 'S', '\u{017F}']);
    }

    #[test]
    fn every_char_that_folds_to_one_ascii_letter_is_listed() {
        let found: Vec<char> = (0x80..=0x10FFFF)
            .filter_map(char::from_u32)
            .filter(|c| {
                let folded = fold(&c.to_string());
                folded.len() == 1 && folded.bytes().all(|b| b.is_ascii_alphabetic())
            })
            .collect();
        let mut listed = NON_ASCII_LETTERS.to_vec();
        listed.sort_unstable();
        assert_eq!(found, listed);
    }
}
