use sandbox_agent::router::ApiDoc;
use serde_json::json;
use utoipa::OpenApi;

#[test]
fn legacy_config_endpoints_are_deprecated() {
    let doc = serde_json::to_value(ApiDoc::openapi()).expect("serialize openapi");
    for path in ["/v1/config/mcp", "/v1/config/skills"] {
        for method in ["get", "put", "delete"] {
            assert_eq!(
                doc["paths"][path][method]["deprecated"],
                json!(true),
                "{method} {path} must be deprecated"
            );
        }
    }
}
