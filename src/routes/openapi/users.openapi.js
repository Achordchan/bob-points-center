/**
 * @openapi
 * {"paths":{"/users/list":{"post":{"tags":["用户"],"summary":"按条件分页查询用户列表（bob_token）","requestBody":{"required":true,"content":{"application/json":{"schema":{"type":"object","additionalProperties":false,"properties":{"bob_token":{"type":"string"},"keyword":{"type":"string"},"page":{"type":"integer","minimum":1,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":30}},"required":["bob_token"]},"examples":{"example":{"value":{"bob_token":"<BOB_TOKEN>","keyword":"","page":1,"pageSize":30}}}}}},"responses":{"200":{"description":"成功","content":{"application/json":{"schema":{"$ref":"#/components/schemas/GenericObject"}}}},"401":{"description":"未授权（缺少或无效 bob_token）","content":{"application/json":{"schema":{"$ref":"#/components/schemas/ErrorResponse"}}}},"500":{"description":"服务端错误","content":{"application/json":{"schema":{"$ref":"#/components/schemas/ErrorResponse"}}}}}}}}}
 */
export {};
