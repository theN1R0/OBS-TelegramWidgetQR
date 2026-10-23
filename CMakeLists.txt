cmake_minimum_required(VERSION 3.28)
project(telegram-widget VERSION 0.1.0 LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "This first native package targets OBS Studio on Windows x64.")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(libobs CONFIG REQUIRED)
find_package(obs-frontend-api CONFIG REQUIRED)
find_package(Qt6 CONFIG REQUIRED COMPONENTS Core Widgets Network)

# Use the public header matching the obs-browser version shipped with the target OBS.
# No CEF SDK or separate browser engine is bundled in this plugin.
find_path(OBS_BROWSER_INCLUDE_DIR browser-panel.hpp
  HINTS "${OBS_SOURCE_DIR}/plugins/obs-browser/panel"
  DOC "Directory containing obs-browser/panel/browser-panel.hpp" REQUIRED)
add_library(telegram-widget MODULE native/plugin-main.cpp)
target_include_directories(telegram-widget PRIVATE "${OBS_BROWSER_INCLUDE_DIR}")
target_link_libraries(telegram-widget PRIVATE OBS::libobs OBS::obs-frontend-api Qt6::Core Qt6::Widgets Qt6::Network)
set_target_properties(telegram-widget PROPERTIES PREFIX "" AUTOMOC OFF)
if(MSVC)
  target_compile_options(telegram-widget PRIVATE /utf-8 /W4 /permissive-)
endif()
install(TARGETS telegram-widget RUNTIME DESTINATION obs-plugins/64bit LIBRARY DESTINATION obs-plugins/64bit)
install(DIRECTORY data/ DESTINATION data/obs-plugins/telegram-widget)

option(TELEGRAM_WIDGET_BUILD_TESTS "Build native path and process regression tests" OFF)
if(TELEGRAM_WIDGET_BUILD_TESTS)
  add_executable(telegram-widget-path-test native/test-paths.cpp)
  target_link_libraries(telegram-widget-path-test PRIVATE Qt6::Core)
  if(MSVC)
    target_compile_options(telegram-widget-path-test PRIVATE /utf-8 /W4)
  endif()
endif()
