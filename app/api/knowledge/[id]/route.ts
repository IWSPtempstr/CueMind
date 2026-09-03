// Phase B：/api/knowledge/<id> 动态段。GET/PATCH/DELETE 的 handler 统一在
// 父级 route.ts 实现；此处包装转发——Next 构建校验要求动态路由导出的 context
// 非可选（RouteContext），而父级 handler 为兼容静态路由使用可选 context。
import type { NextRequest } from "next/server";
import { DELETE as deleteHandler, GET as getHandler, PATCH as patchHandler } from "../route";

type RouteContext = { params: Promise<{ id: string }> };

export function GET(request: NextRequest, context: RouteContext): ReturnType<typeof getHandler> {
  return getHandler(request, context);
}

export function PATCH(request: NextRequest, context: RouteContext): ReturnType<typeof patchHandler> {
  return patchHandler(request, context);
}

export function DELETE(request: NextRequest, context: RouteContext): ReturnType<typeof deleteHandler> {
  return deleteHandler(request, context);
}
