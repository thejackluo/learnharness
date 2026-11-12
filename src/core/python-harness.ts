export const PYTHON_HARNESS = String.raw`
import ast as __lh_ast
import contextlib as __lh_contextlib
import builtins as __lh_builtins
import io as __lh_io
import json as __lh_json
import traceback as __lh_traceback

__lh_request = __lh_json.loads(__lh_request_json)
__lh_namespace = {"__name__": "__main__"}
__lh_capture = __lh_io.StringIO()
__lh_blocked = {"js", "pyodide", "micropip", "builtins", "sys", "os", "posix", "nt", "pathlib", "io", "socket", "ssl", "urllib", "http", "ftplib", "subprocess", "shutil", "tempfile", "importlib"}
__lh_safe_builtins = dict(vars(__lh_builtins))
__lh_real_import = __lh_builtins.__import__

def __lh_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name.split(".")[0] in __lh_blocked:
        raise ImportError("This module is not available in code exercises.")
    return __lh_real_import(name, globals, locals, fromlist, level)

def __lh_no_files(*args, **kwargs):
    raise PermissionError("File access is not available in code exercises.")

__lh_safe_builtins["__import__"] = __lh_import
__lh_safe_builtins["open"] = __lh_no_files
__lh_namespace["__builtins__"] = __lh_safe_builtins

def __lh_error(error):
    line = getattr(error, "lineno", None)
    if line is None:
        for frame in reversed(__lh_traceback.extract_tb(error.__traceback__)):
            if frame.filename in ("<learner>", "<test>"):
                line = frame.lineno
                break
    text = type(error).__name__ + ": " + str(error)
    if line is not None:
        text += " (line " + str(line) + ")"
    return text[:500]

__lh_results = []
def __lh_emit(result):
    __lh_results.append(result)
    if "__lh_post_result" in globals():
        __lh_post_result(__lh_json.dumps(result))

try:
    with __lh_contextlib.redirect_stdout(__lh_capture):
        exec(compile(__lh_request["source"], "<learner>", "exec"), __lh_namespace, __lh_namespace)
    __lh_prelude_stdout = __lh_capture.getvalue()
except BaseException as __lh_error_value:
    __lh_failure = __lh_error(__lh_error_value)
    for __lh_test in __lh_request["tests"]:
        __lh_emit({"testId": __lh_test["id"], "status": "error", "error": __lh_failure, "stdout": __lh_capture.getvalue()[:2000]})
else:
    for __lh_index, __lh_test in enumerate(__lh_request["tests"]):
        __lh_capture = __lh_io.StringIO()
        try:
            with __lh_contextlib.redirect_stdout(__lh_capture):
                __lh_actual = eval(compile(__lh_test["call"], "<test>", "eval"), __lh_namespace, __lh_namespace)
                __lh_expected = __lh_ast.literal_eval(__lh_test["expected"])
            __lh_repr = repr(__lh_actual)[:500]
            __lh_stdout = ((__lh_prelude_stdout if __lh_index == 0 else "") + __lh_capture.getvalue())[:2000]
            __lh_emit({
                "testId": __lh_test["id"],
                "status": "pass" if __lh_actual == __lh_expected else "fail",
                "actual": __lh_repr,
                "stdout": __lh_stdout,
            })
        except BaseException as __lh_error_value:
            __lh_stdout = ((__lh_prelude_stdout if __lh_index == 0 else "") + __lh_capture.getvalue())[:2000]
            __lh_emit({
                "testId": __lh_test["id"],
                "status": "error",
                "error": __lh_error(__lh_error_value),
                "stdout": __lh_stdout,
            })

__lh_json.dumps(__lh_results)
`;
