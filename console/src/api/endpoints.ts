import type { ApiClient } from "./client";
import type {
  Account,
  CreateProgramRequest,
  DeleteResult,
  InitiateUploadRequest,
  InitiateUploadResponse,
  ListGenresResponse,
  ListProgramsByGenreResponse,
  ListSessionsResponse,
  LoginRequest,
  LogoutResponse,
  Program,
  ResetPasswordResponse,
  RevokeSessionResponse,
  SearchEpisodesResponse,
  SearchResponse,
  TokenResponse,
  UpdateAccountRequest,
  UpdateProgramRequest,
  Upload,
  UploadImageResponse,
  VerifyEmailResponse,
} from "./types";

/** Every API operation the console uses, typed from the contract. */
export function createApi(client: ApiClient) {
  return {
    auth: {
      login: (body: LoginRequest) => client.request<TokenResponse>("/api/v1/auth/login", { body, auth: "none" }),
      logout: (refreshToken: string) =>
        client.request<LogoutResponse>("/api/v1/auth/logout", { body: { refreshToken }, auth: "none" }),
      listSessions: () => client.request<ListSessionsResponse>("/api/v1/auth/sessions"),
      revokeSession: (sessionID: string) =>
        client.request<RevokeSessionResponse>(`/api/v1/auth/sessions/${encodeURIComponent(sessionID)}/revoke`, {
          method: "POST",
        }),
      verifyEmail: (token: string) =>
        client.request<VerifyEmailResponse>("/api/v1/auth/email/verify", { body: { token }, auth: "none" }),
      resetPassword: (token: string, password: string) =>
        client.request<ResetPasswordResponse>("/api/v1/auth/password/reset", { body: { token, password }, auth: "none" }),
    },
    account: {
      get: () => client.request<Account>("/api/v1/account"),
      update: (body: UpdateAccountRequest) => client.request<Account>("/api/v1/account", { body }),
    },
    catalog: {
      listGenres: (signal?: AbortSignal) =>
        client.request<ListGenresResponse>("/api/v1/genres", { auth: "appKey", ...(signal ? { signal } : {}) }),
      listProgramsByGenre: (genreID: string, params: { limit?: number; cursor?: string | null } = {}, signal?: AbortSignal) =>
        client.request<ListProgramsByGenreResponse>(`/api/v1/genres/${encodeURIComponent(genreID)}/programs`, {
          auth: "appKey",
          query: { limit: params.limit, cursor: params.cursor },
          ...(signal ? { signal } : {}),
        }),
      getProgram: (programID: string, signal?: AbortSignal) =>
        client.request<Program>(`/api/v1/programs/${encodeURIComponent(programID)}`, {
          auth: "appKey",
          ...(signal ? { signal } : {}),
        }),
      search: (query: string, params: { limit?: number; cursor?: string | null } = {}, signal?: AbortSignal) =>
        client.request<SearchResponse>("/api/v1/search", {
          auth: "appKey",
          query: { query, limit: params.limit, cursor: params.cursor },
          ...(signal ? { signal } : {}),
        }),
      searchEpisodes: (programID: string, query: string, signal?: AbortSignal) =>
        client.request<SearchEpisodesResponse>(`/api/v1/programs/${encodeURIComponent(programID)}/episodes/search`, {
          auth: "appKey",
          query: { query },
          ...(signal ? { signal } : {}),
        }),
    },
    cms: {
      createProgram: (body: CreateProgramRequest) => client.request<Program>("/api/v1/programs", { body }),
      updateProgram: (programID: string, body: UpdateProgramRequest) =>
        client.request<Program>(`/api/v1/programs/${encodeURIComponent(programID)}/update`, { body }),
      deleteProgram: (programID: string) =>
        client.request<DeleteResult>(`/api/v1/programs/${encodeURIComponent(programID)}/delete`, { method: "POST" }),
      deleteEpisode: (episodeID: string) =>
        client.request<DeleteResult>(`/api/v1/episodes/${encodeURIComponent(episodeID)}/delete`, { method: "POST" }),
    },
    uploads: {
      uploadImage: (file: File) => {
        const formData = new FormData();
        formData.append("file", file, file.name);
        return client.request<UploadImageResponse>("/api/v1/uploads/images", { method: "POST", formData });
      },
      initiate: (body: InitiateUploadRequest) => client.request<InitiateUploadResponse>("/api/v1/uploads", { body }),
      complete: (uploadID: string) =>
        client.request<Upload>(`/api/v1/uploads/${encodeURIComponent(uploadID)}/complete`, { method: "POST" }),
      get: (uploadID: string, signal?: AbortSignal) =>
        client.request<Upload>(`/api/v1/uploads/${encodeURIComponent(uploadID)}`, signal ? { signal } : {}),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
