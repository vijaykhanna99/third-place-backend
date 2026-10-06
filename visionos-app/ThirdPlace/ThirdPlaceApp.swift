import SwiftUI

@main
struct ThirdPlaceApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        // Catalog: browse, search, program and episode detail.
        WindowGroup(id: WindowID.catalog) {
            RootView()
                .environment(model)
        }
        .defaultSize(width: 1280, height: 860)

        // Player: one window per episode being watched. AVPlayerViewController
        // takes the window immersive itself (AVExperienceController), so no
        // ImmersiveSpace scene is needed.
        WindowGroup(id: WindowID.player, for: PlayerRequest.self) { $request in
            if let request {
                PlayerWindowView(request: request)
                    .environment(model)
            } else {
                ContentUnavailableView("Nothing to play", systemImage: "play.slash")
            }
        }
        .defaultSize(width: 1600, height: 900)
        .windowStyle(.plain)
    }
}

enum WindowID {
    static let catalog = "catalog"
    static let player = "player"
}
