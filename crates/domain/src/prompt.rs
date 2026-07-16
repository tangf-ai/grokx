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
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    #[default]
    Medium,
    High,
    Xhigh,
    Max,
}

impl ReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::None => "None",
            Self::Minimal => "Minimal",
            Self::Low => "Low",
            Self::Medium => "Medium",
            Self::High => "High",
            Self::Xhigh => "Extra high",
            Self::Max => "Max",
        }
    }

    pub fn all() -> &'static [ReasoningEffort] {
        &[
            Self::None,
            Self::Minimal,
            Self::Low,
            Self::Medium,
            Self::High,
            Self::Xhigh,
            Self::Max,
        ]
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "none" => Some(Self::None),
            "minimal" | "min" => Some(Self::Minimal),
            "low" => Some(Self::Low),
            "medium" | "med" => Some(Self::Medium),
            "high" => Some(Self::High),
            "xhigh" | "extra" | "extra_high" => Some(Self::Xhigh),
            "max" => Some(Self::Max),
            _ => None,
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
