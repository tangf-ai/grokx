use serde::{Deserialize, Serialize};

/// Attachment selected in the composer (path-based; bytes loaded at send time).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct PromptAttachment {
    pub path: String,
    pub name: String,
    pub mime: Option<String>,
    /// File size in bytes when known.
    pub size: Option<u64>,
}

/// Reasoning / effort level for the turn (maps to engine effort flags).
///
/// Wire values align with Grok Build / xAI sampling:
/// `none | minimal | low | medium | high | xhigh` (`max` is a UX alias of `xhigh`).
/// The UI menu only exposes the practical set the engine's legacy menu uses.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    /// No extended reasoning (power-user / API only).
    None,
    /// Minimal reasoning (power-user / API only).
    Minimal,
    Low,
    #[default]
    Medium,
    High,
    /// Maximum reasoning (engine alias: `max` → `xhigh`).
    Xhigh,
}

impl ReasoningEffort {
    /// Canonical wire token sent to the engine (`max` is never emitted).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::None => "None",
            Self::Minimal => "Minimal",
            Self::Low => "Low",
            Self::Medium => "Medium",
            Self::High => "High",
            // Match Grok Build effort menu wording.
            Self::Xhigh => "Extra high",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::None => "No extended reasoning",
            Self::Minimal => "Minimal reasoning",
            Self::Low => "Faster, lighter reasoning",
            Self::Medium => "Balanced reasoning",
            Self::High => "Heavy reasoning",
            Self::Xhigh => "Maximum reasoning",
        }
    }

    /// Levels shown in the desktop composer / settings (Grok Build menu).
    /// `none` / `minimal` remain parseable for API/history but are not listed.
    pub fn menu() -> &'static [ReasoningEffort] {
        &[Self::Low, Self::Medium, Self::High, Self::Xhigh]
    }

    /// All canonical levels including power-user values.
    pub fn all() -> &'static [ReasoningEffort] {
        &[
            Self::None,
            Self::Minimal,
            Self::Low,
            Self::Medium,
            Self::High,
            Self::Xhigh,
        ]
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "none" => Some(Self::None),
            "minimal" | "min" => Some(Self::Minimal),
            "low" => Some(Self::Low),
            "medium" | "med" => Some(Self::Medium),
            "high" => Some(Self::High),
            // Engine treats `max` as alias of `xhigh`.
            "xhigh" | "extra" | "extra_high" | "max" => Some(Self::Xhigh),
            _ => None,
        }
    }

    /// Clamp a stored preference into the UI menu (unknown → Medium).
    pub fn for_menu(self) -> Self {
        match self {
            Self::None | Self::Minimal => Self::Low,
            other => other,
        }
    }
}

/// Full prompt request from the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptRequest {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<PromptAttachment>,
    pub model: Option<String>,
    pub effort: Option<ReasoningEffort>,
}

/// Model advertised by the engine after session/new.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}
