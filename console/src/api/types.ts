/**
 * Application-facing aliases over the generated contract types
 * (src/api/schema.d.ts, produced by `pnpm contract:types`). Nothing in the app
 * describes a request or response shape by hand.
 */
import type { components, paths } from "./schema";

type Schemas = components["schemas"];
type JsonBody<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<P> = P extends { responses: { 200: infer R } } ? JsonBody<R> : never;
type Body<P> = P extends { requestBody: { content: { "application/json": infer B } } } ? B : never;

export type ApiErrorBody = Schemas["Error"];
export type TokenResponse = Schemas["TokenResponse"];
export type Session = Schemas["Session"];
export type Account = Schemas["Account"];
export type Genre = Schemas["Genre"];
export type GenreRef = Schemas["GenreRef"];
export type Stream = Schemas["Stream"];
export type Episode = Schemas["Episode"];
export type EpisodeSummary = Schemas["EpisodeSummary"];
export type Season = Schemas["Season"];
export type Program = Schemas["Program"];
export type ProgramSummary = Schemas["ProgramSummary"];
export type SearchProgramResult = Schemas["SearchProgramResult"];
export type CreateProgramRequest = Schemas["CreateProgramRequest"];
export type CreateSeasonInput = CreateProgramRequest["season"][number];
export type CreateEpisodeInput = CreateSeasonInput["episodes"][number];
export type StreamInput = CreateEpisodeInput["streams"][number];
export type UpdateProgramRequest = Schemas["UpdateProgramRequest"];
export type UpdateEpisodeInput = NonNullable<UpdateProgramRequest["episodes"]>[number];
export type DeleteResult = Schemas["DeleteResult"];
export type Upload = Schemas["Upload"];
export type UploadStatus = Upload["status"];

export type LoginRequest = Body<paths["/api/v1/auth/login"]["post"]>;
export type RefreshRequest = Body<paths["/api/v1/auth/refresh"]["post"]>;
export type LogoutRequest = Body<paths["/api/v1/auth/logout"]["post"]>;
export type LogoutResponse = Ok<paths["/api/v1/auth/logout"]["post"]>;
export type ListSessionsResponse = Ok<paths["/api/v1/auth/sessions"]["get"]>;
export type RevokeSessionResponse = Ok<paths["/api/v1/auth/sessions/{sessionID}/revoke"]["post"]>;
export type VerifyEmailRequest = Body<paths["/api/v1/auth/email/verify"]["post"]>;
export type VerifyEmailResponse = Ok<paths["/api/v1/auth/email/verify"]["post"]>;
export type ResetPasswordRequest = Body<paths["/api/v1/auth/password/reset"]["post"]>;
export type ResetPasswordResponse = Ok<paths["/api/v1/auth/password/reset"]["post"]>;
export type UpdateAccountRequest = Body<paths["/api/v1/account"]["post"]>;
export type ListGenresResponse = Ok<paths["/api/v1/genres"]["get"]>;
export type ListProgramsByGenreResponse = Ok<paths["/api/v1/genres/{genreID}/programs"]["get"]>;
export type SearchResponse = Ok<paths["/api/v1/search"]["get"]>;
export type SearchEpisodesResponse = Ok<paths["/api/v1/programs/{programID}/episodes/search"]["get"]>;
export type UploadImageResponse = Ok<paths["/api/v1/uploads/images"]["post"]>;
export type InitiateUploadRequest = Body<paths["/api/v1/uploads"]["post"]>;
export type InitiateUploadResponse = Ok<paths["/api/v1/uploads"]["post"]>;
