"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const BASE_URL = "http://127.0.0.1:8080";
function showResult(data) {
    const result = document.getElementById("result");
    result.textContent = JSON.stringify(data, null, 2);
}
function request(url_1) {
    return __awaiter(this, arguments, void 0, function* (url, method = "GET", body) {
        const options = {
            method,
            headers: {
                "Content-Type": "application/json"
            }
        };
        if (body !== undefined) {
            options.body = JSON.stringify(body);
        }
        const res = yield fetch(BASE_URL + url, options);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        return yield res.json();
    });
}
function getSkills() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            showResult(yield request("/skills"));
        }
        catch (e) {
            showResult({ error: e.message });
        }
    });
}
function getReload() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            showResult(yield request("/reload"));
        }
        catch (e) {
            showResult({ error: e.message });
        }
    });
}
function getClear() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            showResult(yield request("/clear"));
        }
        catch (e) {
            showResult({ error: e.message });
        }
    });
}
function postTalk() {
    return __awaiter(this, void 0, void 0, function* () {
        const input = document.getElementById("talk-input");
        const text = input.value.trim();
        if (!text) {
            showResult({ error: "Please enter some text for /talk" });
            return;
        }
        try {
            showResult(yield request("/talk", "POST", { text }));
        }
        catch (e) {
            showResult({ error: e.message });
        }
    });
}
function postCd() {
    return __awaiter(this, void 0, void 0, function* () {
        const input = document.getElementById("cd-input");
        const path = input.value.trim();
        if (!path) {
            showResult({ error: "Please enter a path for /cd" });
            return;
        }
        try {
            showResult(yield request("/cd", "POST", { path }));
        }
        catch (e) {
            showResult({ error: e.message });
        }
    });
}
function setup() {
    var _a, _b, _c, _d, _e;
    (_a = document.getElementById("btn-skills")) === null || _a === void 0 ? void 0 : _a.addEventListener("click", () => { getSkills(); });
    (_b = document.getElementById("btn-reload")) === null || _b === void 0 ? void 0 : _b.addEventListener("click", () => { getReload(); });
    (_c = document.getElementById("btn-clear")) === null || _c === void 0 ? void 0 : _c.addEventListener("click", () => { getClear(); });
    (_d = document.getElementById("btn-talk")) === null || _d === void 0 ? void 0 : _d.addEventListener("click", () => { postTalk(); });
    (_e = document.getElementById("btn-cd")) === null || _e === void 0 ? void 0 : _e.addEventListener("click", () => { postCd(); });
}
window.addEventListener("DOMContentLoaded", setup);
