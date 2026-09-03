// Phase B：/api/knowledge/<id> 动态段。GET/PATCH/DELETE 的 handler 统一在
// 父级 route.ts 实现（同时兼容 context.params 与 pathname 解析），此处仅做路由转发。
export { GET, PATCH, DELETE } from "../route";
