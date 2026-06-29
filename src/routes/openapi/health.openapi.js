/**
 * @openapi
 * {"paths":{"/health":{"get":{"tags":["系统"],"summary":"健康检查","responses":{"200":{"description":"成功","content":{"application/json":{"schema":{"$ref":"#/components/schemas/HealthResponse"},"examples":{"example":{"value":{"ok":true}}}}}},"500":{"description":"服务端错误","content":{"application/json":{"schema":{"$ref":"#/components/schemas/ErrorResponse"}}}}}}}}}
 */
export {};
