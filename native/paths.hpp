// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <QDir>
#include <QFileInfo>
#include <QString>

// OBS can return paths relative to its bin/64bit working directory. Freeze that
// context before QProcess changes the child's working directory to module data.
inline QString absoluteObsPath(const QString &path)
{
  return path.isEmpty() ? QString{} : QDir::cleanPath(QFileInfo(path).absoluteFilePath());
}
