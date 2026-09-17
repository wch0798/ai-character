#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>
#include <libgen.h>
#include <mach-o/dyld.h>
#include <fcntl.h>
#include <time.h>
#include <errno.h>

/* Rebuild:
 *   clang -O2 -o "AI Character.app/Contents/MacOS/launcher" tools/ai-character-app-launcher.c
 *   codesign --force --deep -s - "AI Character.app"
 *
 * Terminal 창 없이 백그라운드로 launch-ai-character.sh 실행.
 */

static void log_msg(const char *root, const char *msg) {
  char path[PATH_MAX];
  snprintf(path, sizeof(path), "%s/.ai-character-logs/app-launcher.log", root);
  FILE *f = fopen(path, "a");
  if (!f) return;
  fprintf(f, "%s\n", msg);
  fclose(f);
}

static void die_dialog(const char *msg) {
  char cmd[8192];
  char esc[4096];
  size_t j = 0;
  for (size_t i = 0; msg[i] && j + 2 < sizeof(esc); i++) {
    if (msg[i] == '"' || msg[i] == '\\') esc[j++] = '\\';
    esc[j++] = msg[i];
  }
  esc[j] = '\0';
  snprintf(cmd, sizeof(cmd),
           "/usr/bin/osascript -e 'display dialog \"%s\" buttons {\"확인\"} default button 1 with icon stop' >/dev/null 2>&1",
           esc);
  system(cmd);
  exit(1);
}

static int resolve_root(char *root, size_t root_size) {
  char exe_path[PATH_MAX];
  uint32_t size = sizeof(exe_path);
  if (_NSGetExecutablePath(exe_path, &size) != 0) return -1;

  char resolved[PATH_MAX];
  if (!realpath(exe_path, resolved)) {
    strncpy(resolved, exe_path, sizeof(resolved) - 1);
    resolved[sizeof(resolved) - 1] = '\0';
  }

  char tmp[PATH_MAX];
  strncpy(tmp, resolved, sizeof(tmp) - 1);
  tmp[sizeof(tmp) - 1] = '\0';
  char *macos_dir = dirname(tmp);
  char tmp2[PATH_MAX];
  snprintf(tmp2, sizeof(tmp2), "%s/../../..", macos_dir);
  if (!realpath(tmp2, root)) return -1;
  if (strlen(root) + 1 > root_size) return -1;
  return 0;
}

int main(void) {
  char root[PATH_MAX];
  if (resolve_root(root, sizeof(root)) != 0) {
    die_dialog("프로젝트 폴더를 찾을 수 없습니다.\\nAI Character.app 을 AI-Character 폴더 안에 두세요.");
  }

  char logdir[PATH_MAX];
  snprintf(logdir, sizeof(logdir), "%s/.ai-character-logs", root);
  char mkdir_cmd[PATH_MAX + 64];
  snprintf(mkdir_cmd, sizeof(mkdir_cmd), "/bin/mkdir -p \"%s\"", logdir);
  system(mkdir_cmd);

  char script[PATH_MAX];
  snprintf(script, sizeof(script), "%s/tools/launch-ai-character.sh", root);
  if (access(script, R_OK) != 0) {
    log_msg(root, "missing launch script");
    die_dialog("tools/launch-ai-character.sh 를 찾을 수 없습니다.");
  }

  log_msg(root, "launcher started (headless, no Terminal)");

  /* 더블포크: Finder/.app 종료 후에도 자식이 살아남고 Terminal도 안 뜸 */
  pid_t pid = fork();
  if (pid < 0) {
    die_dialog("실행에 실패했습니다.");
  }
  if (pid > 0) {
    /* 부모(앱)는 바로 종료 → Dock/창 없음 */
    return 0;
  }

  /* 1차 자식 */
  if (setsid() < 0) {
    _exit(1);
  }

  pid = fork();
  if (pid < 0) _exit(1);
  if (pid > 0) _exit(0); /* 중간 프로세스 종료 */

  /* 데몬 자식 */
  if (chdir(root) != 0) {
    log_msg(root, "chdir failed");
    _exit(1);
  }

  char logfile[PATH_MAX];
  time_t now = time(NULL);
  struct tm tm_now;
  localtime_r(&now, &tm_now);
  snprintf(logfile, sizeof(logfile),
           "%s/.ai-character-logs/app-%04d%02d%02d-%02d%02d%02d.log",
           root,
           tm_now.tm_year + 1900, tm_now.tm_mon + 1, tm_now.tm_mday,
           tm_now.tm_hour, tm_now.tm_min, tm_now.tm_sec);

  int logfd = open(logfile, O_WRONLY | O_CREAT | O_APPEND, 0644);
  int nullfd = open("/dev/null", O_RDWR);
  if (nullfd >= 0) {
    dup2(nullfd, STDIN_FILENO);
  }
  if (logfd >= 0) {
    dup2(logfd, STDOUT_FILENO);
    dup2(logfd, STDERR_FILENO);
  } else if (nullfd >= 0) {
    dup2(nullfd, STDOUT_FILENO);
    dup2(nullfd, STDERR_FILENO);
  }
  if (nullfd > 2) close(nullfd);
  if (logfd > 2) close(logfd);

  setenv("AI_CHARACTER_HEADLESS", "1", 1);
  setenv("PATH",
         "/opt/homebrew/bin:/usr/local/bin:/Users/mac_pc/.local/bin:/Users/mac_pc/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin",
         0);

  execl("/bin/bash", "bash", script, (char *)NULL);
  log_msg(root, "execl bash failed");
  _exit(127);
}
