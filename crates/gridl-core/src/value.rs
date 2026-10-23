use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};

/// A single cell, serialized without losing integer precision.
///
/// Integers travel as decimal strings so values above `2^53 - 1` survive JSON.
/// Bytes travel as standard base64. Non-finite floats travel as text.
#[derive(Debug, Clone, PartialEq)]
pub enum SqlValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
}

impl Serialize for SqlValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        match self {
            Self::Null => {
                map.serialize_entry("t", "null")?;
            }
            Self::Bool(value) => {
                map.serialize_entry("t", "bool")?;
                map.serialize_entry("v", value)?;
            }
            Self::Int(value) => {
                map.serialize_entry("t", "int")?;
                map.serialize_entry("v", &value.to_string())?;
            }
            Self::Float(value) => {
                map.serialize_entry("t", "float")?;
                if value.is_finite() {
                    map.serialize_entry("v", value)?;
                } else {
                    map.serialize_entry("v", &value.to_string())?;
                }
            }
            Self::Text(value) => {
                map.serialize_entry("t", "text")?;
                map.serialize_entry("v", value)?;
            }
            Self::Bytes(value) => {
                map.serialize_entry("t", "bytes")?;
                map.serialize_entry("v", &BASE64.encode(value))?;
            }
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for SqlValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(SqlValueVisitor)
    }
}

struct SqlValueVisitor;

impl<'de> Visitor<'de> for SqlValueVisitor {
    type Value = SqlValue;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a tagged SQL value")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut tag: Option<String> = None;
        let mut payload: Option<serde_json::Value> = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "t" => tag = Some(map.next_value()?),
                "v" => payload = Some(map.next_value()?),
                _ => {
                    let _ignored: serde_json::Value = map.next_value()?;
                }
            }
        }
        let tag = tag.ok_or_else(|| de::Error::missing_field("t"))?;
        match tag.as_str() {
            "null" => Ok(SqlValue::Null),
            "bool" => {
                let value = payload.ok_or_else(|| de::Error::missing_field("v"))?;
                Ok(SqlValue::Bool(
                    value.as_bool().ok_or_else(|| de::Error::custom("bool payload"))?,
                ))
            }
            "int" => {
                let value = payload.ok_or_else(|| de::Error::missing_field("v"))?;
                Ok(SqlValue::Int(parse_i64(&value).map_err(de::Error::custom)?))
            }
            "float" => {
                let value = payload.ok_or_else(|| de::Error::missing_field("v"))?;
                Ok(SqlValue::Float(
                    value.as_f64().ok_or_else(|| de::Error::custom("float payload"))?,
                ))
            }
            "text" => {
                let value = payload.ok_or_else(|| de::Error::missing_field("v"))?;
                Ok(SqlValue::Text(
                    value.as_str().ok_or_else(|| de::Error::custom("text payload"))?.to_owned(),
                ))
            }
            "bytes" => {
                let value = payload.ok_or_else(|| de::Error::missing_field("v"))?;
                let encoded = value.as_str().ok_or_else(|| de::Error::custom("bytes payload"))?;
                let bytes =
                    BASE64.decode(encoded).map_err(|err| de::Error::custom(err.to_string()))?;
                Ok(SqlValue::Bytes(bytes))
            }
            other => Err(de::Error::custom(format!("unknown SQL value tag '{other}'"))),
        }
    }
}

fn parse_i64(value: &serde_json::Value) -> Result<i64, String> {
    match value {
        serde_json::Value::String(text) => {
            text.parse::<i64>().map_err(|_| "int out of range".into())
        }
        serde_json::Value::Number(number) => {
            number.as_i64().ok_or_else(|| "int out of range".to_owned())
        }
        _ => Err("int payload".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::SqlValue;

    #[test]
    fn int_roundtrip_preserves_i64_max() {
        let value = SqlValue::Int(i64::MAX);
        let json = serde_json::to_string(&value).expect("serialize");
        assert!(json.contains(&i64::MAX.to_string()));
        let restored: SqlValue = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored, value);
    }

    #[test]
    fn bytes_roundtrip_uses_base64() {
        let value = SqlValue::Bytes(b"hi".to_vec());
        let json = serde_json::to_string(&value).expect("serialize");
        assert!(json.contains("aGk="));
        let restored: SqlValue = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored, value);
    }
}
