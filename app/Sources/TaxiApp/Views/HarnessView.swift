import SwiftUI

struct HarnessView: View {
    private enum Destination: Hashable {
        case newTask, task(String), external, settings
    }

    private let refreshOnAppear: Bool
    @State private var store: HarnessStore
    @State private var draft = HarnessTaskDraft()
    @State private var destination: Destination? = .newTask

    init(store: HarnessStore = HarnessStore(), refreshOnAppear: Bool = true) {
        self.refreshOnAppear = refreshOnAppear
        _store = State(initialValue: store)
        _destination = State(initialValue: store.selectedTaskID.map(Destination.task) ?? .newTask)
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $destination) {
                Label(L("dashboard.newTask"), systemImage: "square.and.pencil")
                    .tag(Destination.newTask)
                    .accessibilityIdentifier("dashboard.newTask")
                Section(L("dashboard.yourTasks")) {
                    if store.snapshot?.tasks.isEmpty != false {
                        Text(L("dashboard.noTasks")).font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(orderedTasks, id: \.task.id) { row in
                        Label {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(row.task.originalRequest).lineLimit(1)
                                Text(row.task.phase + " · " + L("dashboard.state." + (row.task.status ?? "not-started")))
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        } icon: {
                            Image(systemName: row.depth == 0 ? "bubble.left" : "arrow.turn.down.right")
                        }
                        .padding(.leading, CGFloat(min(row.depth, 3)) * 10)
                        .tag(Destination.task(row.task.id))
                    }
                }
                Section(L("dashboard.manage")) {
                    Label(L("dashboard.external"), systemImage: "tray.full").tag(Destination.external)
                    Label(L("dashboard.executionSettings"), systemImage: "slider.horizontal.3").tag(Destination.settings)
                }
            }
            .listStyle(.sidebar)
            .navigationTitle("Taxi")
            .navigationSplitViewColumnWidth(min: 210, ideal: 240, max: 320)
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let error = store.error {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red).textSelection(.enabled)
                    }
                    if let snapshot = store.snapshot {
                        switch destination ?? .newTask {
                        case .newTask:
                            HarnessTaskComposer(store: store, snapshot: snapshot, draft: $draft)
                        case .task(let id):
                            if let task = snapshot.tasks.first(where: { $0.id == id }) {
                                HarnessTaskDetail(store: store, task: task, snapshot: snapshot).id(id)
                            }
                        case .external:
                            Text(L("dashboard.external")).font(.largeTitle.bold())
                            ExternalSessionsView(store: store, snapshot: snapshot)
                        case .settings:
                            HarnessSettingsView(store: store, snapshot: snapshot)
                        }
                    } else {
                        ContentUnavailableView {
                            Label(L("dashboard.connecting"), systemImage: "network")
                        } description: {
                            Text(L("dashboard.startRuntime"))
                        } actions: {
                            Button(L("trust.refresh")) { Task { await store.refresh() } }
                        }
                    }
                }
                .frame(maxWidth: 760, alignment: .leading)
                .padding(32)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .navigationTitle(detailTitle)
            .toolbar {
                ToolbarItemGroup {
                    Button { destination = .newTask } label: {
                        Label(L("dashboard.newTask"), systemImage: "square.and.pencil")
                    }.keyboardShortcut("n", modifiers: .command)
                    Button { Task { await store.refresh() } } label: {
                        Label(L("trust.refresh"), systemImage: "arrow.clockwise")
                    }.disabled(store.busy)
                }
            }
        }
        .onChange(of: destination) { _, next in
            if case .task(let id) = next { store.selectedTaskID = id }
        }
        .onChange(of: store.selectedTaskID) { _, id in
            // Catalog linking owns its own task picker; keep that page open.
            guard destination != .external, let id else { return }
            destination = .task(id)
        }
        .task {
            guard refreshOnAppear else { return }
            await store.refresh()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { break }
                if store.snapshot?.busy == true && !store.busy { await store.refresh() }
            }
        }
    }

    private var detailTitle: String {
        switch destination ?? .newTask {
        case .newTask: L("dashboard.newTask")
        case .task: L("harness.task")
        case .external: L("dashboard.external")
        case .settings: L("dashboard.executionSettings")
        }
    }

    private var orderedTasks: [(task: HarnessTask, depth: Int)] {
        let tasks = store.snapshot?.tasks ?? []
        var result: [(task: HarnessTask, depth: Int)] = []
        var visited = Set<String>()
        func append(_ task: HarnessTask, depth: Int) {
            guard visited.insert(task.id).inserted else { return }
            result.append((task, depth))
            for child in tasks where child.parentId == task.id { append(child, depth: depth + 1) }
        }
        for task in tasks where task.parentId == nil { append(task, depth: 0) }
        for task in tasks where !visited.contains(task.id) { append(task, depth: 0) }
        return result
    }
}
