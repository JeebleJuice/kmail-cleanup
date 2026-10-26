cmake_minimum_required(VERSION 3.20)
project(kmail_cleanup_move LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Core)
find_package(KPim6Akonadi REQUIRED)

add_executable(kmail_cleanup_move move_candidates.cpp)
target_link_libraries(kmail_cleanup_move PRIVATE Qt6::Core KPim6::AkonadiCore)
set_target_properties(kmail_cleanup_move PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}"
)
