import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { NewProgramPage } from "./NewProgramPage";
import { renderWithProviders, signedInStore } from "../test/render";
import { server, TEST_API } from "../test/server";

const GENRE = "01890a5d-ac96-774b-b111-000000000001";
const UPLOAD_A = "01890a5d-ac96-774b-b111-000000000801";
const UPLOAD_B = "01890a5d-ac96-774b-b111-000000000802";

function setup() {
  server.use(
    http.get(`${TEST_API}/api/v1/genres`, () =>
      HttpResponse.json({ genres: [{ id: GENRE, name: "Music", description: "", thumbnailURL: null, programCount: 0 }] }),
    ),
  );
  return renderWithProviders(<NewProgramPage />, {
    route: "/programs/new",
    path: "/programs/new",
    tokenStore: signedInStore(),
    extraRoutes: { "/programs/:id": <h1>Editor stub</h1> },
  });
}

describe("NewProgramPage wizard", () => {
  it("does not leave the details step until the required fields are filled", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Music");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Title is required.")).toBeInTheDocument();
    expect(screen.getByText("Pick at least one genre.")).toBeInTheDocument();
    expect(screen.getByText("A thumbnail URL is required.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Program details" })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Title/), "Neon Nights");
    await user.click(screen.getByLabelText("Music"));
    await user.type(screen.getByRole("textbox", { name: /^Thumbnail/ }), "https://cdn.example/t.jpg");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("season")).toBeInTheDocument();
  });

  it("requires an episode title, a date and a usable angle before the review step", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Music");
    await user.type(screen.getByLabelText(/^Title/), "Neon Nights");
    await user.click(screen.getByLabelText("Music"));
    await user.type(screen.getByRole("textbox", { name: /^Thumbnail/ }), "https://cdn.example/t.jpg");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Episode title is required.")).toBeInTheDocument();
    expect(screen.getByText("Publish date is required.")).toBeInTheDocument();
    expect(screen.getByText("Choose a ZIP archive for this angle.")).toBeInTheDocument();
  });

  it("enables Create only when every angle resolves to a ready upload, then posts the contract body", async () => {
    const user = userEvent.setup();
    let posted: unknown = null;
    server.use(
      http.post(`${TEST_API}/api/v1/programs`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: "01890a5d-ac96-774b-b111-000000000101" });
      }),
    );
    setup();
    await screen.findByText("Music");
    await user.type(screen.getByLabelText(/^Title/), "Neon Nights");
    await user.click(screen.getByLabelText("Music"));
    await user.type(screen.getByRole("textbox", { name: /^Thumbnail/ }), "https://cdn.example/t.jpg");
    await user.click(screen.getByRole("button", { name: "Next" }));

    const episode = screen.getByTestId("episode");
    await user.type(within(episode).getByLabelText(/Episode title/), "Opening Night");
    await user.type(within(episode).getByLabelText(/Publish date/), "2026-07-01T12:00");

    // First angle: an existing upload.
    const angle1 = within(episode).getAllByTestId("angle")[0]!;
    await user.selectOptions(within(angle1).getByLabelText("Source"), "existing");
    await user.type(within(angle1).getByLabelText(/uploadID/), UPLOAD_A);

    // Second angle: still a ZIP that was never chosen — must block.
    await user.click(within(episode).getByRole("button", { name: /Add angle/ }));
    const angle2 = within(episode).getAllByTestId("angle")[1]!;
    await user.type(within(angle2).getByLabelText(/Angle name/), "Side");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Choose a ZIP archive for this angle.")).toBeInTheDocument();

    await user.selectOptions(within(angle2).getByLabelText("Source"), "existing");
    await user.type(within(angle2).getByLabelText(/uploadID/), UPLOAD_B);
    await user.click(screen.getByRole("button", { name: "Next" }));

    const create = screen.getByRole("button", { name: "Create program" });
    expect(create).toBeEnabled();
    await user.click(create);

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({
      title: "Neon Nights",
      genreIDs: [GENRE],
      thumbnailURL: "https://cdn.example/t.jpg",
      season: [
        {
          number: 1,
          episodes: [
            {
              number: 1,
              title: "Opening Night",
              streams: [
                { name: "Main", uploadID: UPLOAD_A },
                { name: "Side", uploadID: UPLOAD_B },
              ],
            },
          ],
        },
      ],
    });
    expect(await screen.findByText("Editor stub")).toBeInTheDocument();
  });

  it("shows the API error code when the create call is rejected", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${TEST_API}/api/v1/programs`, () =>
        HttpResponse.json({ error: { code: "upload_not_ready", message: "Upload is not in ready state" } }, { status: 409 }),
      ),
    );
    setup();
    await screen.findByText("Music");
    await user.type(screen.getByLabelText(/^Title/), "Neon Nights");
    await user.click(screen.getByLabelText("Music"));
    await user.type(screen.getByRole("textbox", { name: /^Thumbnail/ }), "https://cdn.example/t.jpg");
    await user.click(screen.getByRole("button", { name: "Next" }));
    const episode = screen.getByTestId("episode");
    await user.type(within(episode).getByLabelText(/Episode title/), "Opening Night");
    await user.type(within(episode).getByLabelText(/Publish date/), "2026-07-01T12:00");
    const angle1 = within(episode).getAllByTestId("angle")[0]!;
    await user.selectOptions(within(angle1).getByLabelText("Source"), "existing");
    await user.type(within(angle1).getByLabelText(/uploadID/), UPLOAD_A);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Create program" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("upload_not_ready: Upload is not in ready state");
  });
});
