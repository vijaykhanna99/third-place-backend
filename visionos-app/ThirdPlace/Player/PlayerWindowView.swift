import AVKit
import SwiftUI
import ThirdPlaceAPI

/// The player window: AVPlayerViewController (immersive via its experience
/// controller) plus an ornament for switching camera angles.
struct PlayerWindowView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismissWindow) private var dismissWindow
    let request: PlayerRequest

    @State private var coordinator: PlayerCoordinator?

    var body: some View {
        Group {
            if let coordinator {
                PlayerContent(coordinator: coordinator, title: request.title)
            } else {
                LoadingView()
            }
        }
        .task {
            if coordinator == nil {
                let c = model.makePlayer(for: request.episodeID)
                coordinator = c
                await c.start()
            }
        }
        .onDisappear {
            coordinator?.stop()
            coordinator = nil
        }
    }
}

private struct PlayerContent: View {
    @Bindable var coordinator: PlayerCoordinator
    let title: String
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        ZStack {
            ImmersivePlayerView(player: coordinator.player)
                .ignoresSafeArea()
            if case .loading = coordinator.state {
                LoadingView()
            }
            if case .failed(let message) = coordinator.state {
                ContentUnavailableView {
                    Label("Can't play \(title)", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Retry") { Task { await coordinator.start() } }
                    Button("Close") { dismissWindow(id: WindowID.player) }
                }
                .background(.regularMaterial)
            }
        }
        .ornament(
            visibility: coordinator.streams.count > 1 ? .visible : .hidden,
            attachmentAnchor: .scene(.bottom),
            contentAlignment: .center
        ) {
            AngleSwitcher(coordinator: coordinator)
        }
        .ornament(attachmentAnchor: .scene(.top), contentAlignment: .center) {
            Text(title)
                .font(.headline)
                .padding(.horizontal, 20).padding(.vertical, 10)
                .glassBackgroundEffect()
        }
    }
}

/// Camera-angle switcher (v1.1 multi-angle): one button per `streams[]` entry.
struct AngleSwitcher: View {
    @Bindable var coordinator: PlayerCoordinator

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "camera.on.rectangle").foregroundStyle(.secondary)
            ForEach(Array(coordinator.streams.enumerated()), id: \.offset) { index, stream in
                Button {
                    coordinator.select(angle: index)
                } label: {
                    Text(stream.name)
                        .font(.body.weight(index == coordinator.selectedIndex ? .bold : .regular))
                        .padding(.horizontal, 14).padding(.vertical, 8)
                }
                .buttonStyle(.bordered)
                .tint(index == coordinator.selectedIndex ? .accentColor : .secondary)
                .accessibilityLabel("Camera angle \(stream.name)")
                .accessibilityAddTraits(index == coordinator.selectedIndex ? .isSelected : [])
            }
        }
        .padding(10)
        .glassBackgroundEffect()
    }
}

/// AVPlayerViewController hosted in SwiftUI. On visionOS 2 the view controller
/// owns the immersive presentation: MV-HEVC content plays stereoscopically and
/// the experience controller lets it expand to the immersive experience.
struct ImmersivePlayerView: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.allowsPictureInPicturePlayback = false
        controller.experienceController.allowedExperiences = .recommended([.embedded, .expanded, .immersive])
        Task { @MainActor in
            await controller.experienceController.transition(to: .immersive)
        }
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
    }
}
