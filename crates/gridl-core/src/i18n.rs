//! Language of the messages the backend shows to the user.
//!
//! Gridl speaks English and Spanish. The language follows the operating system:
//! Spanish when the first preferred language is Spanish, English otherwise. The
//! `GRIDL_LANG` environment variable (`en` or `es`) overrides it, which keeps
//! tests and screenshots predictable.
//!
//! Messages are written next to the code that raises them with [`tr!`], which
//! takes the English and the Spanish text and formats the one in use.

use std::cell::Cell;
use std::sync::atomic::{AtomicU8, Ordering};

/// A language the interface is available in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Locale {
    #[default]
    En,
    Es,
}

impl Locale {
    /// Reads a language tag such as `es-MX`, `es_ES.UTF-8`, or `en-US`.
    /// Anything that is not Spanish is English.
    pub fn from_tag(tag: &str) -> Self {
        if tag.trim().to_ascii_lowercase().starts_with("es") {
            Locale::Es
        } else {
            Locale::En
        }
    }

    /// The two-letter code, as the frontend and `GRIDL_LANG` spell it.
    pub fn code(self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::Es => "es",
        }
    }

    fn to_bits(self) -> u8 {
        match self {
            Locale::En => 1,
            Locale::Es => 2,
        }
    }

    fn from_bits(bits: u8) -> Option<Self> {
        match bits {
            1 => Some(Locale::En),
            2 => Some(Locale::Es),
            _ => None,
        }
    }
}

/// 0 until the language is first needed.
static CURRENT: AtomicU8 = AtomicU8::new(0);

thread_local! {
    static SCOPED: Cell<Option<Locale>> = const { Cell::new(None) };
}

/// The language from `GRIDL_LANG`, or else from the system's preferred languages.
pub fn detect() -> Locale {
    if let Ok(value) = std::env::var("GRIDL_LANG") {
        if !value.trim().is_empty() {
            return Locale::from_tag(&value);
        }
    }
    sys_locale::get_locale().map(|tag| Locale::from_tag(&tag)).unwrap_or_default()
}

/// The language messages are written in. It is detected once and then kept.
pub fn locale() -> Locale {
    if let Some(scoped) = SCOPED.with(Cell::get) {
        return scoped;
    }
    if let Some(current) = Locale::from_bits(CURRENT.load(Ordering::Relaxed)) {
        return current;
    }
    let detected = detect();
    CURRENT.store(detected.to_bits(), Ordering::Relaxed);
    detected
}

/// Sets the language for the whole process.
pub fn set_locale(locale: Locale) {
    CURRENT.store(locale.to_bits(), Ordering::Relaxed);
}

/// Runs `work` with messages in `locale` on this thread only, then restores
/// what was there. Tests use it to render one message in both languages.
pub fn with_locale<T>(locale: Locale, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<Locale>);
    impl Drop for Restore {
        fn drop(&mut self) {
            SCOPED.with(|scoped| scoped.set(self.0));
        }
    }
    let _restore = Restore(SCOPED.with(|scoped| scoped.replace(Some(locale))));
    work()
}

/// Formats the English or the Spanish text, whichever the interface uses.
///
/// ```
/// let seconds = 30;
/// let message = gridl_core::tr!("Timed out after {seconds} s", "Se agotó a los {seconds} s");
/// assert!(message.contains("30"));
/// ```
#[macro_export]
macro_rules! tr {
    ($en:literal, $es:literal $(,)?) => {
        match $crate::locale() {
            $crate::Locale::En => ::std::format!($en),
            $crate::Locale::Es => ::std::format!($es),
        }
    };
    ($en:literal, $es:literal, $($arg:tt)+) => {
        match $crate::locale() {
            $crate::Locale::En => ::std::format!($en, $($arg)+),
            $crate::Locale::Es => ::std::format!($es, $($arg)+),
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_language_tags() {
        assert_eq!(Locale::from_tag("es"), Locale::Es);
        assert_eq!(Locale::from_tag("es-MX"), Locale::Es);
        assert_eq!(Locale::from_tag("ES_es.UTF-8"), Locale::Es);
        assert_eq!(Locale::from_tag("en-US"), Locale::En);
        assert_eq!(Locale::from_tag("pt-BR"), Locale::En);
        assert_eq!(Locale::from_tag(""), Locale::En);
    }

    #[test]
    fn scoped_language_wins_and_is_restored() {
        let outer = locale();
        let seconds = 5;
        let english = with_locale(Locale::En, || tr!("{seconds} s left", "quedan {seconds} s"));
        let spanish = with_locale(Locale::Es, || {
            let nested = with_locale(Locale::En, || tr!("yes", "sí"));
            assert_eq!(nested, "yes");
            tr!("{seconds} s left", "quedan {seconds} s")
        });
        assert_eq!(english, "5 s left");
        assert_eq!(spanish, "quedan 5 s");
        assert_eq!(locale(), outer);
    }
}
