import SwiftUI
import ThirdPlaceAPI

/// Genres → programs. The genre set is small and unpaginated (contract).
struct BrowseView: View {
    @Environment(AppModel.self) private var model
    @State private var state: LoadState<[Genre]> = .idle

    private let columns = [GridItem(.adaptive(minimum: 320, maximum: 420), spacing: 24)]

    var body: some View {
        Group {
            switch state {
            case .idle, .loading:
                LoadingView()
            case .failed(let message):
                ErrorView(message: message) { Task { await load() } }
            case .loaded(let genres):
                if genres.isEmpty {
                    ContentUnavailableView("No genres yet", systemImage: "film.stack")
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 24) {
                            ForEach(genres) { genre in
                                NavigationLink(value: genre) {
                                    GenreCard(genre: genre)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(32)
                    }
                }
            }
        }
        .navigationTitle("Third Place")
        .navigationDestination(for: Genre.self) { genre in
            GenreProgramsView(genre: genre)
        }
        .navigationDestination(for: ProgramSummary.self) { program in
            ProgramDetailView(programID: program.id, title: program.title)
        }
        .navigationDestination(for: ProgramRoute.self) { route in
            ProgramDetailView(programID: route.programID, title: route.title)
        }
        .task { if state == .idle { await load() } }
        .refreshable { await load() }
    }

    private func load() async {
        state = .loading
        do {
            state = .loaded(try await model.api.genres())
        } catch {
            state = .failed(error.userMessage)
        }
    }
}

/// Navigation value for program detail from places that only know the id (search results).
struct ProgramRoute: Hashable {
    let programID: String
    let title: String
}

struct GenreCard: View {
    let genre: Genre

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ThumbnailView(url: genre.thumbnailURL)
                .frame(height: 200)
            Text(genre.name).font(.title2.weight(.semibold))
            Text(genre.description).font(.body).foregroundStyle(.secondary).lineLimit(2)
            Text("\(genre.programCount) program\(genre.programCount == 1 ? "" : "s")")
                .font(.footnote).foregroundStyle(.tertiary)
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .hoverEffect()
    }
}

/// Programs of one genre, cursor-paginated: the next page loads when the last
/// card appears.
struct GenreProgramsView: View {
    @Environment(AppModel.self) private var model
    let genre: Genre

    @State private var programs: [ProgramSummary] = []
    @State private var nextCursor: String?
    @State private var total = 0
    @State private var loading = false
    @State private var error: String?

    private let columns = [GridItem(.adaptive(minimum: 300, maximum: 380), spacing: 24)]

    var body: some View {
        Group {
            if let error, programs.isEmpty {
                ErrorView(message: error) { Task { await loadFirstPage() } }
            } else if programs.isEmpty && loading {
                LoadingView()
            } else if programs.isEmpty {
                ContentUnavailableView("No programs in \(genre.name) yet", systemImage: "film")
            } else {
                ScrollView {
                    if total > 0 {
                        Text("\(total) program\(total == 1 ? "" : "s")")
                            .font(.footnote).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 32).padding(.top, 24)
                    }
                    LazyVGrid(columns: columns, spacing: 24) {
                        ForEach(programs) { program in
                            NavigationLink(value: program) {
                                ProgramCard(program: program)
                            }
                            .buttonStyle(.plain)
                            .task {
                                if program.id == programs.last?.id { await loadNextPage() }
                            }
                        }
                    }
                    .padding(32)
                    if loading { ProgressView().padding() }
                    if let error { Text(error).foregroundStyle(.red).padding() }
                }
            }
        }
        .navigationTitle(genre.name)
        .task { if programs.isEmpty { await loadFirstPage() } }
    }

    private func loadFirstPage() async {
        programs = []
        nextCursor = nil
        await loadPage()
    }

    private func loadNextPage() async {
        guard nextCursor != nil, !loading else { return }
        await loadPage()
    }

    private func loadPage() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let page = try await model.api.programs(inGenre: genre.id, cursor: nextCursor)
            programs.append(contentsOf: page.programs.filter { p in !programs.contains { $0.id == p.id } })
            nextCursor = page.nextCursor
            total = page.total
        } catch {
            self.error = error.userMessage
        }
    }
}

struct ProgramCard: View {
    let program: ProgramSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ThumbnailView(url: program.thumbnailURL)
                .frame(height: 180)
            Text(program.title).font(.title3.weight(.semibold)).lineLimit(2)
            Text(program.description).font(.callout).foregroundStyle(.secondary).lineLimit(2)
            Text(program.genre.map(\.name).joined(separator: " · "))
                .font(.footnote).foregroundStyle(.tertiary)
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .hoverEffect()
    }
}
