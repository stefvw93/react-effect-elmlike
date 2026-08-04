/**
 * A long-lived external subscription — the other half of what commands are for.
 *
 * `Stream.callback` turns a push source into a command that emits many actions
 * over one scope. Started from `@mounted`, it lives exactly as long as the
 * component does; React unmounting closes the scope, which runs the socket's
 * finalizers. No `useEffect` cleanup function, no dependency array, no
 * subscribe/unsubscribe pair to keep in sync.
 *
 * `@unmounted` is here for the part the scope cannot express: telling the
 * *server* we left. It is honestly scoped — it fires on SPA navigation, not on
 * tab close.
 */

import { Context, Effect, Queue, Schema, Scope, Stream } from "effect";
import { define, type ActionOf } from "../lib/tea";

// --- domain -----------------------------------------------------------------

interface Peer {
  readonly id: string;
  readonly name: string;
}

type PresenceEvent =
  | { readonly kind: "sync"; readonly peers: ReadonlyArray<Peer> }
  | { readonly kind: "enter"; readonly peer: Peer }
  | { readonly kind: "exit"; readonly peerId: string }
  | { readonly kind: "dropped" };

export class PresenceSocket extends Context.Service<
  PresenceSocket,
  {
    /** Scoped: closing the scope closes the socket. */
    readonly join: (
      roomId: string,
      onEvent: (event: PresenceEvent) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly announceLeave: (roomId: string) => Effect.Effect<void>;
  }
>()("PresenceSocket") {}

// --- community hook ---------------------------------------------------------

declare function usePageVisible(): boolean;

// --- actions ----------------------------------------------------------------

const RosterSynced = Schema.TaggedStruct("RosterSynced", {
  peers: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
const PeerEntered = Schema.TaggedStruct("PeerEntered", {
  peer: Schema.Struct({ id: Schema.String, name: Schema.String }),
});
const PeerExited = Schema.TaggedStruct("PeerExited", { peerId: Schema.String });
const ConnectionDropped = Schema.TaggedStruct("ConnectionDropped", {});
const VisibilityChanged = Schema.TaggedStruct("VisibilityChanged", {
  visible: Schema.Boolean,
});

const actions = [
  RosterSynced,
  PeerEntered,
  PeerExited,
  ConnectionDropped,
  VisibilityChanged,
] as const;

type PresenceAction = ActionOf<typeof actions>;

const eventToAction = (event: PresenceEvent): PresenceAction => {
  switch (event.kind) {
    case "sync":
      return { _tag: "RosterSynced", peers: event.peers };
    case "enter":
      return { _tag: "PeerEntered", peer: event.peer };
    case "exit":
      return { _tag: "PeerExited", peerId: event.peerId };
    case "dropped":
      return { _tag: "ConnectionDropped" };
  }
};

// --- blueprint --------------------------------------------------------------

const Props = Schema.Struct({
  roomId: Schema.String,
  selfId: Schema.String,
});

const State = Schema.Struct({
  peers: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  connected: Schema.Boolean,
  idle: Schema.Boolean,
});

const Presence = define({
  props: Props,
  state: State,
  actions,
  hooks: function usePresenceHooks() {
    return { visible: usePageVisible() };
  },
});

export const presence = Presence.create({
  initialState: () => ({
    peers: [],
    connected: false,
    idle: false,
  }),

  reducer: {
    // One command, one scope, many actions, for as long as the component lives.
    "@mounted": ({ props, state }) => [
      { ...state, connected: true },
      Stream.callback<PresenceAction, never, PresenceSocket | Scope.Scope>((queue) =>
        Effect.flatMap(PresenceSocket, (socket) =>
          socket.join(props.roomId, (event) => {
            Queue.offerUnsafe(queue, eventToAction(event));
          }),
        ),
      ),
    ],

    RosterSynced: (action, { state }) => ({
      ...state,
      peers: action.peers,
      connected: true,
    }),

    PeerEntered: (action, { state }) =>
      state.peers.some((peer) => peer.id === action.peer.id)
        ? state
        : { ...state, peers: [...state.peers, action.peer] },

    PeerExited: (action, { state }) => ({
      ...state,
      peers: state.peers.filter((peer) => peer.id !== action.peerId),
    }),

    ConnectionDropped: (_action, { state }) => ({
      ...state,
      connected: false,
      peers: [],
    }),

    VisibilityChanged: (action, { state }) => ({ ...state, idle: !action.visible }),

    // A hook's value changing is an external event, so it is an action like any
    // other. This one is forwarded into the domain vocabulary rather than
    // handled inline, which keeps the state's story readable in a replay log.
    "@hookChanged": (action, { state }) => {
      switch (action.hook) {
        case "visible":
          return [
            state,
            Stream.succeed({
              _tag: "VisibilityChanged" as const,
              visible: action.next,
            }),
          ];
      }
    },

    // Tell the server. Runs on the root scope, so it survives this component
    // being torn down — but not the tab being closed.
    "@unmounted": ({ props }) =>
      Effect.flatMap(PresenceSocket, (socket) => socket.announceLeave(props.roomId)),
  },

  render: ({ state, props }) => (
    <aside aria-live="polite" data-idle={state.idle}>
      {state.connected ? null : <p role="status">Reconnecting…</p>}
      <ul>
        {state.peers
          .filter((peer) => peer.id !== props.selfId)
          .map((peer) => (
            <li key={peer.id}>{peer.name}</li>
          ))}
      </ul>
    </aside>
  ),
});
