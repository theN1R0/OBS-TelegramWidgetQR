// SPDX-License-Identifier: GPL-2.0-or-later
#include <obs-module.h>
#include <obs-frontend-api.h>
#include <obs-hotkey.h>
#include <graphics/vec2.h>
#include <util/platform.h>
#include <util/bmem.h>
#include <browser-panel.hpp>
#include "paths.hpp"
#include <QApplication>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPointer>
#include <QProcess>
#include <QPushButton>
#include <QTimer>
#include <QUrl>
#include <QVBoxLayout>
#include <memory>
#include <cstring>

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE("telegram-widget", "en-US")
OBS_MODULE_AUTHOR("AnimeFlow")

namespace {
constexpr const char *DockId = "animeflow.telegram-widget";
constexpr const char *SourceName = "Telegram Widget";

QString modulePath(const char *relative)
{
  char *value = obs_module_file(relative);
  const QString result = QString::fromUtf8(value ? value : "");
  bfree(value);
  return absoluteObsPath(result);
}
QString configPath(const char *relative)
{
  char *value = obs_module_config_path(relative);
  const QString result = QString::fromUtf8(value ? value : "");
  bfree(value);
  return absoluteObsPath(result);
}

class Runtime final : public QObject {
public:
  Runtime() : QObject(nullptr)
  {
    dock = new QWidget;
    dock->setMinimumSize(280, 320);
    auto *layout = new QVBoxLayout(dock);
    layout->setContentsMargins(0, 0, 0, 0);
    status = new QLabel(QString::fromUtf8("Запускаем локальный Telegram-виджет…"), dock);
    status->setWordWrap(true);
    status->setMargin(16);
    layout->addWidget(status);
    addButton = new QPushButton(QString::fromUtf8("Добавить источник в текущую сцену"), dock);
    addButton->setEnabled(false);
    addButton->setStyleSheet("QPushButton { background:#20252d; color:#d6e3f0; border:1px solid #343843; border-radius:6px; padding:10px; margin:8px; } QPushButton:hover { background:#2a3440; }");
    layout->addWidget(addButton);
    connect(addButton, &QPushButton::clicked, this, [this] { addSource(); });
    registered = obs_frontend_add_dock_by_id(DockId, "Telegram Widget", dock);
    if (!registered) {
      delete dock;
      dock = nullptr;
      return;
    }
    connect(&process, &QProcess::readyReadStandardOutput, this, [this] { receiveOutput(); });
    connect(&process, &QProcess::readyReadStandardError, this, [this] {
      const QString detail = QString::fromUtf8(process.readAllStandardError()).trimmed();
      if (!detail.isEmpty()) {
        serviceError = (serviceError + "\n" + detail).trimmed().left(1600);
        setStatus(serviceError);
      }
    });
    connect(&process, &QProcess::errorOccurred, this, [this](QProcess::ProcessError) {
      startupTimer.stop();
      setStatus(QString::fromUtf8("Локальный процесс не запущен. Проверьте runtime/node.exe и файлы пакета."));
    });
    connect(&process, qOverload<int, QProcess::ExitStatus>(&QProcess::finished), this,
      [this](int code, QProcess::ExitStatus) {
        if (stopping) return;
        startupTimer.stop();
        ready = false;
        if (addButton) addButton->setEnabled(false);
        setStatus(QString::fromUtf8("Локальный виджет остановился (код %1).").arg(code) +
          (serviceError.isEmpty() ? QString{} : "\n\n" + serviceError));
        if (restarts++ < 3) QTimer::singleShot(2000, this, [this] { startService(); });
      });
    startupTimer.setSingleShot(true);
    connect(&startupTimer, &QTimer::timeout, this, [this] {
      if (!ready) setStatus(QString::fromUtf8("Не удалось дождаться запуска. Проверьте журнал OBS и комплектность пакета."));
    });
    showHotkey = obs_hotkey_register_frontend("telegram-widget.show", "Telegram Widget: Show", hotkeyShow, this);
    hideHotkey = obs_hotkey_register_frontend("telegram-widget.hide", "Telegram Widget: Hide", hotkeyHide, this);
    toggleHotkey = obs_hotkey_register_frontend("telegram-widget.toggle", "Telegram Widget: Show/Hide", hotkeyToggle, this);
    loadHotkeys();
    startService();
  }
  ~Runtime() override
  {
    stopping = true;
    startupTimer.stop();
    if (registered) {
      saveHotkeys();
      obs_hotkey_unregister(showHotkey);
      obs_hotkey_unregister(hideHotkey);
      obs_hotkey_unregister(toggleHotkey);
    }
    if (browser) browser->closeBrowser();
    if (registered) obs_frontend_remove_dock(DockId);
    if (dock) delete dock.data();
    cef.reset();
    process.terminate();
    if (!process.waitForFinished(1200)) { process.kill(); process.waitForFinished(1200); }
  }
  void addSource()
  {
    if (!ready) return;
    obs_source_t *sceneSource = obs_frontend_get_current_scene();
    obs_scene_t *scene = sceneSource ? obs_scene_from_source(sceneSource) : nullptr;
    if (!scene) { if (sceneSource) obs_source_release(sceneSource); return; }
    obs_source_t *source = obs_get_source_by_name(SourceName);
    if (source) {
      obs_data_t *settings = obs_source_get_settings(source);
      const bool managed = obs_data_get_bool(settings, "telegram_widget_managed");
      obs_data_release(settings);
      if (!managed) {
        setStatus(QString::fromUtf8("Источник «Telegram Widget» уже существует и создан не этим плагином. Переименуйте его."));
        obs_source_release(source);
        obs_source_release(sceneSource);
        return;
      }
    } else {
      obs_data_t *settings = obs_data_create();
      obs_data_set_string(settings, "url", overlayUrl().toUtf8().constData());
      obs_data_set_int(settings, "width", 1920);
      obs_data_set_int(settings, "height", 1080);
      obs_data_set_int(settings, "fps", 60);
      obs_data_set_bool(settings, "fps_custom", true);
      obs_data_set_bool(settings, "shutdown", false);
      obs_data_set_bool(settings, "restart_when_active", false);
      obs_data_set_bool(settings, "telegram_widget_managed", true);
      source = obs_source_create("browser_source", SourceName, settings, nullptr);
      obs_data_release(settings);
    }
    if (source) {
      if (!obs_scene_find_source(scene, obs_source_get_name(source))) {
        obs_sceneitem_t *item = obs_scene_add(scene, source);
        obs_video_info video = {};
        if (item && obs_get_video_info(&video)) {
          struct vec2 bounds;
          vec2_set(&bounds, static_cast<float>(video.base_width), static_cast<float>(video.base_height));
          obs_sceneitem_set_bounds_type(item, OBS_BOUNDS_SCALE_INNER);
          obs_sceneitem_set_bounds(item, &bounds);
        }
      }
      obs_source_release(source);
    } else setStatus(QString::fromUtf8("Не удалось создать браузерный источник. Установите OBS с компонентом Browser Source."));
    obs_source_release(sceneSource);
  }
  void saveHotkeys()
  {
    obs_data_t *settings = obs_data_create();
    saveHotkey(settings, "show", showHotkey);
    saveHotkey(settings, "hide", hideHotkey);
    saveHotkey(settings, "toggle", toggleHotkey);
    const QByteArray file = configPath("hotkeys.json").toUtf8();
    obs_data_save_json_safe(settings, file.constData(), "tmp", "bak");
    obs_data_release(settings);
  }
private:
  QPointer<QWidget> dock;
  QPointer<QLabel> status;
  QPointer<QPushButton> addButton;
  QPointer<QCefWidget> browser;
  std::unique_ptr<QCef> cef;
  QProcess process;
  QNetworkAccessManager network;
  QTimer startupTimer;
  QByteArray output;
  QString origin, accessKey, serviceError;
  bool registered = false, ready = false, stopping = false;
  int restarts = 0;
  obs_hotkey_id showHotkey = OBS_INVALID_HOTKEY_ID, hideHotkey = OBS_INVALID_HOTKEY_ID, toggleHotkey = OBS_INVALID_HOTKEY_ID;

  void setStatus(const QString &text)
  {
    if (status) { status->setText(text); status->show(); }
    // Never log browser URLs or access keys.
    blog(LOG_WARNING, "[Telegram Widget] %s", text.toUtf8().constData());
  }
  void startService()
  {
    if (stopping) return;
    const QString runtime = modulePath("runtime/node.exe");
    const QString service = modulePath("service/main.js");
    if (!QFile::exists(runtime) || !QFile::exists(service)) {
      setStatus(QString::fromUtf8("Неполная установка: отсутствуют runtime/node.exe или service/main.js. Установите весь пакет, а не только DLL."));
      return;
    }
    const QString dir = configPath("local");
    if (!QDir().mkpath(dir)) { setStatus(QString::fromUtf8("Нет прав на запись настроек плагина.")); return; }
    output.clear();
    serviceError.clear();
    process.setWorkingDirectory(modulePath("."));
    process.setProgram(runtime);
    process.setArguments({service, "--data-dir", dir, "--port", "45871", "--parent-pid", QString::number(QCoreApplication::applicationPid())});
    process.start();
    startupTimer.start(15000);
  }
  QString overlayUrl() const { return origin + "/overlay?key=" + accessKey; }
  void receiveOutput()
  {
    output += process.readAllStandardOutput();
    while (output.contains('\n')) {
      const int end = output.indexOf('\n');
      const QByteArray line = output.left(end).trimmed();
      output.remove(0, end + 1);
      if (!line.startsWith("TW_READY ")) continue;
      const auto json = QJsonDocument::fromJson(line.mid(9)).object();
      const QString nextOrigin = json.value("origin").toString();
      const QString nextKey = json.value("key").toString();
      const QUrl url(nextOrigin);
      if (url.scheme() != "http" || url.host() != "127.0.0.1" || url.port() != 45871 || nextKey.size() != 64) {
        setStatus(QString::fromUtf8("Некорректный ответ локального процесса."));
        return;
      }
      origin = nextOrigin;
      accessKey = nextKey;
      ready = true;
      startupTimer.stop();
      if (!browser) {
        cef.reset(obs_browser_init_panel());
        if (!cef) { setStatus(QString::fromUtf8("В этой сборке OBS недоступны браузерные панели.")); return; }
        cef->init_browser();
        if (!cef->wait_for_browser_init()) { setStatus(QString::fromUtf8("Не удалось запустить браузер OBS.")); return; }
        browser = cef->create_widget(dock, (origin + "/dock?key=" + accessKey).toStdString());
        if (!browser) { setStatus(QString::fromUtf8("Не удалось создать панель Telegram.")); return; }
        auto *layout = static_cast<QVBoxLayout *>(dock->layout());
        layout->insertWidget(1, browser, 1);
      } else browser->setURL((origin + "/dock?key=" + accessKey).toStdString());
      if (status) status->hide();
      if (addButton) addButton->setEnabled(true);
      obs_enum_sources([](void *data, obs_source_t *source) {
        auto *self = static_cast<Runtime *>(data);
        const char *id = obs_source_get_unversioned_id(source);
        if (!id || strcmp(id, "browser_source") != 0) return true;
        obs_data_t *settings = obs_source_get_settings(source);
        if (obs_data_get_bool(settings, "telegram_widget_managed")) {
          const QByteArray url = self->overlayUrl().toUtf8();
          if (strcmp(obs_data_get_string(settings, "url"), url.constData()) != 0) {
            obs_data_set_string(settings, "url", url.constData());
            obs_source_update(source, settings);
          }
        }
        obs_data_release(settings);
        return true;
      }, this);
      blog(LOG_INFO, "[Telegram Widget] Local service and dock are ready");
    }
    if (output.size() > 65536) output.clear();
  }
  void command(const char *name)
  {
    if (!ready || stopping) return;
    QNetworkRequest request{QUrl(origin + "/api/" + QString::fromUtf8(name))};
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    request.setRawHeader("X-Widget-Token", accessKey.toUtf8());
    request.setTransferTimeout(20000);
    QNetworkReply *reply = network.post(request, "{}");
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
      if (reply->error() != QNetworkReply::NoError) setStatus(QString::fromUtf8("Не удалось выполнить команду. Проверьте ссылку в панели Telegram."));
      reply->deleteLater();
    });
  }
  static void queueCommand(Runtime *self, const char *name)
  {
    QMetaObject::invokeMethod(self, [self, name] { self->command(name); }, Qt::QueuedConnection);
  }
  static void hotkeyShow(void *data, obs_hotkey_id, obs_hotkey_t *, bool pressed) { if (pressed) queueCommand(static_cast<Runtime *>(data), "show"); }
  static void hotkeyHide(void *data, obs_hotkey_id, obs_hotkey_t *, bool pressed) { if (pressed) queueCommand(static_cast<Runtime *>(data), "hide"); }
  static void hotkeyToggle(void *data, obs_hotkey_id, obs_hotkey_t *, bool pressed) { if (pressed) queueCommand(static_cast<Runtime *>(data), "toggle"); }
  static void saveHotkey(obs_data_t *settings, const char *name, obs_hotkey_id id)
  {
    obs_data_array_t *keys = obs_hotkey_save(id);
    obs_data_set_array(settings, name, keys);
    obs_data_array_release(keys);
  }
  void loadHotkeys()
  {
    const QByteArray file = configPath("hotkeys.json").toUtf8();
    obs_data_t *settings = obs_data_create_from_json_file(file.constData());
    if (!settings) return;
    const auto load = [settings](const char *name, obs_hotkey_id id) {
      obs_data_array_t *keys = obs_data_get_array(settings, name);
      if (keys) { obs_hotkey_load(id, keys); obs_data_array_release(keys); }
    };
    load("show", showHotkey); load("hide", hideHotkey); load("toggle", toggleHotkey);
    obs_data_release(settings);
  }
};

std::unique_ptr<Runtime> runtime;
void frontendEvent(enum obs_frontend_event event, void *)
{
  if (event == OBS_FRONTEND_EVENT_FINISHED_LOADING && !runtime) runtime = std::make_unique<Runtime>();
  if (event == OBS_FRONTEND_EVENT_EXIT) runtime.reset();
}
void saveCallback(obs_data_t *, bool saving, void *)
{
  if (saving && runtime) runtime->saveHotkeys();
}
} // namespace

MODULE_EXPORT const char *obs_module_description(void)
{
  return "Standalone Telegram QR and post widget with a local OBS dock";
}
bool obs_module_load(void)
{
  obs_frontend_add_event_callback(frontendEvent, nullptr);
  obs_frontend_add_save_callback(saveCallback, nullptr);
  blog(LOG_INFO, "[Telegram Widget] Loaded 0.1.0");
  return true;
}
void obs_module_unload(void)
{
  obs_frontend_remove_event_callback(frontendEvent, nullptr);
  obs_frontend_remove_save_callback(saveCallback, nullptr);
  runtime.reset();
}
