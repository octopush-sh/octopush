//! How a case-insensitive APFS volume compares file names (#1229): two
//! names are the same file when they match after Unicode canonical
//! decomposition (NFD) and full case folding. So `ſ` is `s`, the Kelvin
//! sign is `k`, `ﬂ` is `fl`, and a composed `é` is `e` followed by U+0301.
//! The Talk guard reads names through [`fold`], and the sandbox's
//! case-insensitive deny regexes take their spellings from [`forms_at`],
//! so both match a name the way the volume does.

use std::sync::OnceLock;

use caseless::Caseless;
use unicode_normalization::UnicodeNormalization;

/// `name` as the volume compares it: NFD, full case folding, then NFD again
/// (folding can produce a character that decomposes). Two names are the
/// same file when their folds are equal.
pub fn fold(name: &str) -> String {
    name.chars().nfd().default_case_fold().nfd().collect()
}

/// The characters outside ASCII whose fold is all ASCII: the sharp s and
/// capital sharp s (`ss`), the long s (`s`), the Greek question mark (`;`),
/// the Greek varia (a backtick), the Kelvin sign (`k`) and the Latin
/// ligatures of U+FB00 (`ff`, `fi`, `fl`, `ffi`, `ffl`, `st`, `st`).
/// `every_char_whose_fold_is_ascii_is_listed` checks the list.
const ASCII_FOLDING: [char; 13] = [
    '\u{00DF}', '\u{017F}', '\u{037E}', '\u{1E9E}', '\u{1FEF}', '\u{212A}', '\u{FB00}', '\u{FB01}', '\u{FB02}',
    '\u{FB03}', '\u{FB04}', '\u{FB05}', '\u{FB06}',
];

/// Every character whose fold is all ASCII, with its fold: ASCII itself,
/// then [`ASCII_FOLDING`].
fn ascii_folds() -> &'static [(char, String)] {
    static FOLDS: OnceLock<Vec<(char, String)>> = OnceLock::new();
    FOLDS.get_or_init(|| {
        (0u8..0x80).map(char::from).chain(ASCII_FOLDING).map(|c| (c, fold(&c.to_string()))).collect()
    })
}

/// The single characters a name folded to the ASCII `folded` can start
/// with, grouped by how much of `folded` each stands for, shortest first:
/// for `"st…"`, `s`, `S` and `ſ` stand for one letter and `ﬅ` and `ﬆ` for
/// two. Every spelling of `folded` is a run of these.
pub fn forms_at(folded: &str) -> Vec<(usize, Vec<char>)> {
    let mut groups: Vec<(usize, Vec<char>)> = Vec::new();
    for (c, f) in ascii_folds() {
        if f.is_empty() || !folded.starts_with(f.as_str()) {
            continue;
        }
        match groups.iter_mut().find(|(n, _)| *n == f.len()) {
            Some((_, g)) => g.push(*c),
            None => groups.push((f.len(), vec![*c])),
        }
    }
    groups.sort_by_key(|(n, _)| *n);
    groups
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
    fn forms_are_both_cases_the_characters_that_fold_to_the_letter_and_the_ligatures() {
        assert_eq!(forms_at("a"), vec![(1, vec!['A', 'a'])]);
        assert_eq!(forms_at("k"), vec![(1, vec!['K', 'k', '\u{212A}'])]);
        assert_eq!(forms_at("."), vec![(1, vec!['.'])]);
        assert_eq!(forms_at(";"), vec![(1, vec![';', '\u{037E}'])]);
        assert_eq!(
            forms_at("st"),
            vec![(1, vec!['S', 's', '\u{017F}']), (2, vec!['\u{FB05}', '\u{FB06}'])]
        );
        assert_eq!(forms_at("ss"), vec![(1, vec!['S', 's', '\u{017F}']), (2, vec!['\u{DF}', '\u{1E9E}'])]);
        assert_eq!(
            forms_at("ffle"),
            vec![(1, vec!['F', 'f']), (2, vec!['\u{FB00}']), (3, vec!['\u{FB04}'])]
        );
        // Only prefixes of `folded` count.
        assert_eq!(forms_at("f"), vec![(1, vec!['F', 'f'])]);
        assert!(forms_at("").is_empty());
    }

    #[test]
    fn every_ligature_of_the_latin_block_folds_to_its_letters() {
        let expected = ["ff", "fi", "fl", "ffi", "ffl", "st", "st"];
        for (c, letters) in ('\u{FB00}'..='\u{FB06}').zip(expected) {
            assert_eq!(fold(&c.to_string()), letters, "U+{:04X}", c as u32);
            assert!(ASCII_FOLDING.contains(&c), "U+{:04X}", c as u32);
        }
        // The Armenian ligatures of the block fold to Armenian letters.
        for c in '\u{FB13}'..='\u{FB17}' {
            assert!(!fold(&c.to_string()).is_ascii(), "U+{:04X}", c as u32);
        }
    }

    #[test]
    fn every_char_whose_fold_is_ascii_is_listed() {
        let found: Vec<char> = (0x80..=0x10FFFF)
            .filter_map(char::from_u32)
            .filter(|c| {
                let folded = fold(&c.to_string());
                !folded.is_empty() && folded.is_ascii()
            })
            .collect();
        assert_eq!(found, ASCII_FOLDING.to_vec());
    }
}
