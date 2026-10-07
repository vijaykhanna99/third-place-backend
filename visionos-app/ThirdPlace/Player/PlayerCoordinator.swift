import AVFoundation
import Foundation
import Observation
import ThirdPlaceAPI

/// What the player window is asked to play.
struct PlayerRequest: Codable, Hashable {
    let episodeID: String
    let title: String
}

/// Owns the AVPlayer for one episode: fetches tokenised stream URLs, switches
/// camera angles, refreshes tokens before they expire, and reports telemetry.
///
/// Token refresh (spec §5.2/§5.3): the API's tokens live 15 minutes, and a VOD
/// playlist is fetched once, so the segment URLs AVPlayer holds carry the
/// token they were rewritten with. Shortly before expiry the coordinator asks
/// `/stream` again and swaps in a new player item at the same position. The
/// edge caches segments without the token, so the swap re-reads from cache; a
/// short rebuffer is expected at that moment in v1.
@MainActor
@Observable
final class PlayerCoordinator {
    enum State: Equatable {
        case loading
        case playing
        case failed(String)
    }

    let player = AVPlayer()
    private(set) var state: State = .loading
    private(set) var streams: [StreamAngle] = []
    private(set) var selectedIndex = 0
    private(set) var expiresAt: Date?

    private let api: APIClient
    private let episodeID: String
    private let telemetry: PlaybackTelemetry
    private var refreshTask: Task<Void, Never>?
    private var statusObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private var periodicObserver: Any?
    private var completed = false

    init(api: APIClient, episodeID: String) {
        self.api = api
        self.episodeID = episodeID
        self.telemetry = PlaybackTelemetry(api: api, episodeID: episodeID)
        player.automaticallyWaitsToMinimizeStalling = true
        periodicObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 30, preferredTimescale: 1),
            queue: .main
        ) { [weak self] time in
            guard let self, self.player.timeControlStatus == .playing else { return }
            self.telemetry.report(.progress, position: time.seconds)
        }
    }

    var currentStream: StreamAngle? {
        streams.indices.contains(selectedIndex) ? streams[selectedIndex] : nil
    }

    var currentSeconds: Double {
        let t = player.currentTime()
        return t.isNumeric ? max(0, t.seconds) : 0
    }

    /// Fetches fresh stream URLs and starts the default angle.
    func start() async {
        state = .loading
        do {
            let response = try await api.streams(episodeID: episodeID)
            apply(response, keepingPosition: false)
            state = .playing
            player.play()
            telemetry.report(.start, position: 0)
        } catch {
            state = .failed(error.userMessage)
            telemetry.report(.error, position: 0)
        }
    }

    /// Switches to another camera angle at the same position.
    func select(angle index: Int) {
        guard streams.indices.contains(index), index != selectedIndex else { return }
        selectedIndex = index
        swapItem(to: streams[index].streamURL, keepingPosition: true)
    }

    func stop() {
        refreshTask?.cancel()
        player.pause()
        if !completed { telemetry.report(.progress, position: currentSeconds) }
        detachItemObservers()
        if let periodicObserver { player.removeTimeObserver(periodicObserver) }
        periodicObserver = nil
        player.replaceCurrentItem(with: nil)
    }

    // MARK: - Streams and tokens

    private func apply(_ response: StreamsResponse, keepingPosition: Bool) {
        streams = response.streams
        expiresAt = response.expiresAt
        selectedIndex = min(selectedIndex, max(0, streams.count - 1))
        guard let stream = currentStream else {
            state = .failed("This episode has no streams.")
            return
        }
        // A refresh that produced the same object only needs the new token.
        swapItem(to: stream.streamURL, keepingPosition: keepingPosition)
        scheduleRefresh(response)
    }

    private func scheduleRefresh(_ response: StreamsResponse) {
        refreshTask?.cancel()
        let at = StreamURLs.refreshDate(for: response)
        refreshTask = Task { [weak self] in
            let delay = max(1, at.timeIntervalSinceNow)
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            await self.refreshTokens()
        }
    }

    private func refreshTokens() async {
        do {
            let response = try await api.streams(episodeID: episodeID)
            apply(response, keepingPosition: true)
        } catch {
            // Keep playing on the current token and try again shortly; it is
            // still valid until expiresAt.
            refreshTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled, let self else { return }
                await self.refreshTokens()
            }
        }
    }

    private func swapItem(to url: URL, keepingPosition: Bool) {
        let position = keepingPosition ? player.currentTime() : .zero
        let wasPlaying = player.timeControlStatus != .paused
        detachItemObservers()
        let item = AVPlayerItem(url: url)
        item.preferredForwardBufferDuration = 12
        attachItemObservers(item)
        player.replaceCurrentItem(with: item)
        if keepingPosition, position.isNumeric, position.seconds > 0 {
            player.seek(to: position, toleranceBefore: .zero, toleranceAfter: .positiveInfinity)
        }
        if wasPlaying { player.play() }
    }

    // MARK: - Item observation

    private func attachItemObservers(_ item: AVPlayerItem) {
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            let message = item.error?.localizedDescription ?? "Playback failed."
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.state = .failed(message)
                self.telemetry.report(.error, position: self.currentSeconds)
            }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.completed = true
                self.telemetry.report(.complete, position: self.currentSeconds)
            }
        }
    }

    private func detachItemObservers() {
        statusObservation?.invalidate()
        statusObservation = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
    }
}

/// Fire-and-forget playback telemetry (spec §9). One anonymous session id per
/// player instance; failures are ignored — the API drops invalid events and
/// the player must never surface telemetry problems.
final class PlaybackTelemetry: Sendable {
    private let api: APIClient
    private let episodeID: String
    let sessionUUID = UUID().uuidString.lowercased()

    init(api: APIClient, episodeID: String) {
        self.api = api
        self.episodeID = episodeID
    }

    func report(_ kind: PlaybackEvent.Kind, position: Double) {
        let event = PlaybackEvent(
            episodeID: episodeID,
            event: kind,
            positionSec: position.isFinite ? max(0, position) : 0,
            quality: nil, // ABR decides; the client does not know the rendition
            sessionUUID: sessionUUID
        )
        let api = self.api
        Task.detached(priority: .utility) {
            try? await api.record(event)
        }
    }
}
