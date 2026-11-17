/*
 * OpenEdit minimal CEP interface (MIT, part of OpenEdit).
 * Implements only the small subset of the CEP JavaScript interface that the
 * OpenEdit panel uses, on top of the native window.__adobe_cep__ object that
 * every CEP host injects. Avoids redistributing Adobe's CSInterface.js.
 */
(function (global) {
  "use strict";

  var SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication"
  };

  function cep() {
    if (!global.__adobe_cep__) {
      throw new Error("Not running inside an Adobe CEP host");
    }
    return global.__adobe_cep__;
  }

  function CSInterface() {}

  CSInterface.prototype.getSystemPath = function (pathType) {
    var raw = decodeURI(cep().getSystemPath(pathType));
    // CEP returns file URLs: file:///C:/... on Windows, file:///Users/... on macOS.
    if (/^file:\/\/\/[A-Za-z]:/.test(raw)) return raw.replace("file:///", "");
    return raw.replace(/^file:\/\//, "");
  };

  CSInterface.prototype.evalScript = function (script, callback) {
    cep().evalScript(script, typeof callback === "function" ? callback : function () {});
  };

  CSInterface.prototype.getHostEnvironment = function () {
    try {
      return JSON.parse(cep().getHostEnvironment());
    } catch (e) {
      return null;
    }
  };

  CSInterface.prototype.addEventListener = function (type, listener, obj) {
    cep().addEventListener(type, listener, obj);
  };

  CSInterface.prototype.closeExtension = function () {
    cep().closeExtension();
  };

  global.SystemPath = SystemPath;
  global.CSInterface = CSInterface;
})(typeof window !== "undefined" ? window : this);
