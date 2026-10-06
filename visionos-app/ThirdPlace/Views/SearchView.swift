import SwiftUI
import ThirdPlaceAPI

/// General search (spec §6.5): results grouped by program; a program match
/// lists its episodes (capped at 20 by the API), an episode-only match lists
/// just the matching episodes.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var results: [SearchProgramResult] = []
    @State private var nextCursor: String?
    @State private var total = 0
    @State private var loading = false
    @State private var error: String?
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        Group {
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
                ContentUnavailableView("Search programs and episodes", systemImage: "magnifyingglass")
            } else if let error, results.isEmpty {
                ErrorView(message: error) { search(reset: true) }
            } else if results.isEmpty && loading {
                LoadingView()
            } else if results.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                List {
                    ForEach(results) { result in
                        Section {
                            NavigationLink(value: ProgramRoute(programID: result.id, title: result.title)) {
                                HStack(spacing: 14) {
                                    ThumbnailView(url: result.thumbnailURL, cornerRadius: 10)
                                        .frame(width: 120, height: 68)
                                    VStack(alignment: .leading) {
                                        Text(result.title).font(.headline)
                                        Text(result.matchedBy == .program ? "Program matched" : "Episodes matched")
                                            .font(.footnote).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            ForEach(result.episodes) { episode in
                                NavigationLink(value: ProgramRoute(programID: result.id, title: result.title)) {
                                    HStack {
                                        Text("S\(episode.seasonNumber) E\(episode.number)")
                                            .font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
                                            .frame(width: 70, alignment: .leading)
                                        Text(episode.title)
                                        Spacer()
                                        Text(episode.durationSec.durationLabel).foregroundStyle(.tertiary)
                                    }
                                }
                            }
                        }
                        .task {
                            if result.id == results.last?.id { search(reset: false) }
                        }
                    }
                    if loading { ProgressView().frame(maxWidth: .infinity) }
                    if total > results.count {
                        Text("\(results.count) of \(total) results loaded")
                            .font(.footnote).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .navigationTitle("Search")
        .navigationDestination(for: ProgramRoute.self) { route in
            ProgramDetailView(programID: route.programID, title: route.title)
        }
        .searchable(text: $query, prompt: "Titles and descriptions")
        .onChange(of: query) { _, _ in
            // Debounce typing: one request per pause, not per keystroke.
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                search(reset: true)
            }
        }
        .onSubmit(of: .search) { search(reset: true) }
    }

    private func search(reset: Bool) {
        let text = query.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else {
            results = []
            total = 0
            nextCursor = nil
            return
        }
        if !reset && (nextCursor == nil || loading) { return }
        Task {
            loading = true
            error = nil
            defer { loading = false }
            do {
                let page = try await model.api.search(query: text, cursor: reset ? nil : nextCursor)
                guard page.query == text else { return } // a newer query has superseded this one
                if reset { results = page.programs } else { results.append(contentsOf: page.programs) }
                nextCursor = page.nextCursor
                total = page.total
            } catch is CancellationError {
                // superseded
            } catch {
                self.error = error.userMessage
            }
        }
    }
}
