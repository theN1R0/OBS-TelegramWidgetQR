// SPDX-License-Identifier: GPL-2.0-or-later
#include "paths.hpp"
#include <QCoreApplication>
#include <QFile>
#include <QProcess>
#include <QTemporaryDir>
#include <iostream>

int main(int argc, char **argv)
{
  QCoreApplication app(argc, argv);
  const auto fail = [](const char *message) { std::cerr << message << '\n'; return 1; };
  if (app.arguments().size() != 2) return fail("Pass the absolute path to node.exe");
  const QString node = app.arguments().at(1);
  QTemporaryDir fixture(QDir::tempPath() + QString::fromUtf8("/telegram paths тест-XXXXXX"));
  if (!fixture.isValid()) return fail("Cannot create test fixture");
  QDir tree(fixture.path());
  if (!tree.mkpath("bin/64bit") || !tree.mkpath("data/obs-plugins/telegram-widget/service")) return fail("Cannot create directories");
  const QString relativeData = "../../data/obs-plugins/telegram-widget";
  const QString relativeScript = relativeData + "/service/main.js";
  const QString expectedScript = tree.filePath("data/obs-plugins/telegram-widget/service/main.js");
  QFile script(expectedScript);
  if (!script.open(QIODevice::WriteOnly)) return fail("Cannot create fixture script");
  script.write("process.stdout.write('SERVICE_PATH_OK');\n");
  script.close();
  const QString previous = QDir::currentPath();
  if (!QDir::setCurrent(tree.filePath("bin/64bit"))) return fail("Cannot enter OBS bin directory");
  const QString data = absoluteObsPath(relativeData);
  const QString resolvedScript = absoluteObsPath(relativeScript);
  if (!QDir::isAbsolutePath(data) || resolvedScript != expectedScript) return fail("OBS relative path was not frozen correctly");
  if (absoluteObsPath(resolvedScript) != resolvedScript || !absoluteObsPath({}).isEmpty()) return fail("Absolute/empty paths changed");
  // Reproduce the old bug: from the module data directory, this relative script
  // points to obs-studio/data/data/... rather than the real service file.
  if (QFileInfo::exists(QDir(data).absoluteFilePath(relativeScript))) return fail("Fixture does not reproduce the old double-data bug");
  QProcess child;
  child.setWorkingDirectory(data);
  child.setProgram(node);
  child.setArguments({resolvedScript});
  child.start();
  const bool started = child.waitForStarted(5000);
  const bool finished = started && child.waitForFinished(10000);
  QDir::setCurrent(previous);
  if (!finished) { child.kill(); child.waitForFinished(2000); return fail("Node process did not finish"); }
  if (child.exitStatus() != QProcess::NormalExit || child.exitCode() != 0 || child.readAllStandardOutput() != "SERVICE_PATH_OK") {
    std::cerr << child.readAllStandardError().constData();
    return fail("Node could not launch the service after working-directory change");
  }
  std::cout << "PASS: relative OBS paths, absolute/empty paths, spaces/Cyrillic and QProcess service launch after cwd change\n";
  return 0;
}
