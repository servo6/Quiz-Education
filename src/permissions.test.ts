import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCan, can, canActOnUser, ForbiddenError, isProtectedAccount, type Actor } from "./permissions.ts";

const admin: Actor = { role: "ADMIN", managedSubjectIds: new Set() };
const orgAdmin: Actor = { role: "ORG_ADMIN", managedSubjectIds: new Set(), adminOrgIds: new Set(["utbm"]), orgSubjectIds: new Set(["chimie", "maths"]) };
const manager: Actor = { role: "SUBJECT_MANAGER", managedSubjectIds: new Set(["chimie"]) };
const user: Actor = { role: "USER", managedSubjectIds: new Set() };

test("le super administrateur peut tout faire", () => {
  assert.ok(can(admin, "org:create"));
  assert.ok(can(admin, "backup:export"));
  assert.ok(can(admin, "question:import", "histoire"));
  assert.ok(can(admin, "question:import")); // sans matière précisée
});

test("l'administrateur d'organisation gère SON organisation et ses matières, rien d'autre", () => {
  assert.ok(can(orgAdmin, "subject:create", "utbm"));
  assert.ok(can(orgAdmin, "org:manage", "utbm"));
  assert.ok(can(orgAdmin, "subject:delete", "chimie"));
  assert.ok(can(orgAdmin, "managers:assign", "maths"));
  assert.ok(can(orgAdmin, "question:import", "chimie"));
  assert.equal(can(orgAdmin, "subject:create", "autre-org"), false);
  assert.equal(can(orgAdmin, "subject:delete", "histoire"), false);
  assert.equal(can(orgAdmin, "question:import", "histoire"), false);
  for (const a of ["org:create", "org:delete", "orgadmin:manage", "settings:global", "users:list", "users:ban", "users:resetPassword", "badges:manage", "avatars:manage", "tiers:manage", "backup:export", "logs:viewAll"] as const) {
    assert.equal(can(orgAdmin, a, "utbm"), false, a);
  }
});

test("le responsable gère uniquement ses matières", () => {
  assert.ok(can(manager, "question:import", "chimie"));
  assert.ok(can(manager, "chapter:manage", "chimie"));
  assert.ok(can(manager, "members:revoke", "chimie"));
  assert.ok(can(manager, "subject:settings", "chimie"));
  assert.ok(can(manager, "logs:viewSubject", "chimie"));
  assert.equal(can(manager, "question:import", "histoire"), false);
  assert.equal(can(manager, "question:delete", "histoire"), false);
});

test("le responsable ne peut pas agir sans préciser la matière", () => {
  assert.equal(can(manager, "question:import"), false);
  assert.equal(can(orgAdmin, "question:import"), false);
});

test("le responsable n'a aucun droit global, d'organisation ni de suppression de matière", () => {
  for (const a of ["org:create", "org:delete", "org:manage", "orgadmin:manage", "subject:create", "subject:delete", "subject:rename", "settings:global", "users:list", "users:ban", "users:resetPassword", "managers:assign", "badges:manage", "avatars:manage", "tiers:manage", "backup:export", "logs:viewAll", "logs:viewOrg"] as const) {
    assert.equal(can(manager, a, "chimie"), false, a);
  }
});

test("un utilisateur simple n'a aucun droit d'administration", () => {
  assert.equal(can(user, "question:import", "chimie"), false);
  assert.equal(can(user, "members:view", "chimie"), false);
});

test("action inconnue refusée", () => {
  assert.equal(can(admin, "n'importe:quoi" as never), false);
});

test("assertCan lève ForbiddenError", () => {
  assert.throws(() => assertCan(manager, "question:import", "histoire"), ForbiddenError);
  assert.doesNotThrow(() => assertCan(manager, "question:import", "chimie"));
});

test("le compte du super administrateur est intouchable", () => {
  assert.ok(isProtectedAccount("ADMIN"));
  assert.equal(isProtectedAccount("ORG_ADMIN"), false);
  assert.equal(canActOnUser(admin, "ADMIN", "chimie"), false);
  assert.equal(canActOnUser(orgAdmin, "ADMIN", "chimie"), false);
  assert.equal(canActOnUser(manager, "ADMIN", "chimie"), false);
});

test("qui peut agir sur qui", () => {
  assert.ok(canActOnUser(manager, "USER", "chimie"));
  assert.equal(canActOnUser(manager, "USER", "histoire"), false);
  assert.equal(canActOnUser(manager, "SUBJECT_MANAGER", "chimie"), false);
  assert.equal(canActOnUser(manager, "ORG_ADMIN", "chimie"), false);
  assert.ok(canActOnUser(orgAdmin, "SUBJECT_MANAGER", "maths"));
  assert.ok(canActOnUser(orgAdmin, "USER", "chimie"));
  assert.equal(canActOnUser(orgAdmin, "USER", "histoire"), false);
  assert.equal(canActOnUser(orgAdmin, "ORG_ADMIN", "chimie"), false);
  assert.ok(canActOnUser(admin, "SUBJECT_MANAGER", "histoire"));
  assert.ok(canActOnUser(admin, "ORG_ADMIN", "histoire"));
});
