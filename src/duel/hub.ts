import type { Server } from "socket.io";
import type { Hub } from "./engine.ts";
import { notificationFor, type Pusher } from "../push.ts";

/** Présence des joueurs (plusieurs onglets possibles) et envoi d'événements à un joueur via Socket.IO. */
export class SocketHub implements Hub {
  private io?: Server;
  /** Notifications push : doublent les événements importants pour les joueurs hors de l'appli. */
  pusher?: Pusher;
  private readonly sockets = new Map<string, Set<string>>();

  attach(io: Server): void {
    this.io = io;
  }

  /** Renvoie true si c'est la première connexion de ce joueur. */
  add(userId: string, socketId: string): boolean {
    const set = this.sockets.get(userId) ?? new Set<string>();
    const first = set.size === 0;
    set.add(socketId);
    this.sockets.set(userId, set);
    return first;
  }

  /** Renvoie true si c'était la dernière connexion de ce joueur. */
  remove(userId: string, socketId: string): boolean {
    const set = this.sockets.get(userId);
    if (!set) return false;
    set.delete(socketId);
    if (set.size === 0) {
      this.sockets.delete(userId);
      return true;
    }
    return false;
  }

  isOnline(userId: string): boolean {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }

  emit(userId: string, event: string, payload: unknown): void {
    this.io?.to(`user:${userId}`).emit(event, payload);
    if (this.pusher?.enabled) {
      const n = notificationFor(event, (payload ?? {}) as Record<string, unknown>);
      if (n) void this.pusher.send(userId, n);
    }
  }
}
