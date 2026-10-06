import SwiftUI
import ThirdPlaceAPI

/// Program detail (spec §6.1): seasons and their episodes, each with its
/// camera angles. Tapping an episode opens the episode sheet, whose Play
/// button opens the player window.
struct ProgramDetailView: View {
    @Environment(AppModel.self) private var model
    let programID: String
    let title: String

    @State private var state: LoadState<Program> = .idle
    @State private var selectedEpisode: Episode?

    var body: some View {
        Group {
            switch state {
            case .idle, .loading:
                LoadingView()
            case .failed(let message):
                ErrorView(message: message) { Task { await load() } }
            case .loaded(let program):
                content(program)
            }
        }
        .navigationTitle(state.value?.title ?? title)
        .task { if state == .idle { await load() } }
        .refreshable { await load() }
        .sheet(item: $selectedEpisode) { episode in
            EpisodeDetailView(program: state.value, episode: episode)
        }
    }

    private func content(_ program: Program) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header(program)
                ForEach(program.season) { season in
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(alignment: .firstTextBaseline) {
                            Text("Season \(season.number)").font(.title2.weight(.semibold))
                            Text(season.title).font(.title3).foregroundStyle(.secondary)
                        }
                        if !season.description.isEmpty {
                            Text(season.description).foregroundStyle(.secondary)
                        }
                        ForEach(season.episodes) { episode in
                            Button { selectedEpisode = episode } label: {
                                EpisodeRow(episode: episode)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(32)
        }
    }

    private func header(_ program: Program) -> some View {
        HStack(alignment: .top, spacing: 24) {
            ThumbnailView(url: program.thumbnailURL)
                .frame(width: 360, height: 220)
            VStack(alignment: .leading, spacing: 10) {
                Text(program.title).font(.largeTitle.weight(.bold))
                Text(program.genre.map(\.name).joined(separator: " · "))
                    .font(.callout).foregroundStyle(.secondary)
                Text(program.description).font(.body)
                HStack(spacing: 16) {
                    Label(program.owner.displayName, systemImage: "person.crop.circle")
                    Label("\(program.viewCount) plays", systemImage: "play.circle")
                    Label("\(program.allEpisodes.count) episodes", systemImage: "list.number")
                }
                .font(.footnote).foregroundStyle(.tertiary)
            }
        }
    }

    private func load() async {
        state = .loading
        do {
            state = .loaded(try await model.api.program(id: programID))
        } catch {
            state = .failed(error.userMessage)
        }
    }
}

struct EpisodeRow: View {
    let episode: Episode

    var body: some View {
        HStack(spacing: 18) {
            ThumbnailView(url: episode.thumbnailURL, cornerRadius: 12)
                .frame(width: 200, height: 112)
            VStack(alignment: .leading, spacing: 6) {
                Text("\(episode.number). \(episode.title)").font(.title3.weight(.semibold))
                Text(episode.description).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                HStack(spacing: 12) {
                    Label(episode.durationSec.durationLabel, systemImage: "clock")
                    Label(
                        episode.streams.count == 1 ? "1 angle" : "\(episode.streams.count) angles",
                        systemImage: "camera.on.rectangle"
                    )
                    Text(episode.publishedAt, style: .date)
                }
                .font(.footnote).foregroundStyle(.tertiary)
            }
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .hoverEffect()
    }
}

/// Episode sheet: metadata, the angle list, and Play. `streams[]` from program
/// detail is shown for information; the player always asks `/stream` for
/// fresh tokens when it starts (spec §5.3).
struct EpisodeDetailView: View {
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismiss) private var dismiss
    let program: Program?
    let episode: Episode

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 24) {
                ThumbnailView(url: episode.thumbnailURL)
                    .frame(width: 400, height: 225)
                VStack(alignment: .leading, spacing: 10) {
                    if let program { Text(program.title).font(.headline).foregroundStyle(.secondary) }
                    Text("Episode \(episode.number): \(episode.title)").font(.title.weight(.bold))
                    Text(episode.description)
                    Label(episode.durationSec.durationLabel, systemImage: "clock")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Camera angles").font(.headline)
                HStack(spacing: 10) {
                    ForEach(Array(episode.streams.enumerated()), id: \.offset) { index, stream in
                        Label(stream.name, systemImage: index == 0 ? "camera.fill" : "camera")
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(.thinMaterial, in: Capsule())
                    }
                }
                Text("Switch angles any time while watching.").font(.footnote).foregroundStyle(.tertiary)
            }
            Spacer()
            HStack {
                Button("Close") { dismiss() }
                Spacer()
                Button {
                    openWindow(id: WindowID.player, value: PlayerRequest(episodeID: episode.id, title: episode.title))
                    dismiss()
                } label: {
                    Label("Play", systemImage: "play.fill").font(.title3.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.extraLarge)
            }
        }
        .padding(32)
        .frame(minWidth: 820, minHeight: 520)
    }
}
